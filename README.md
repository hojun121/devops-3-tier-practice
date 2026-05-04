# Backend CI/CD 구축 가이드 (Blue/Green)

본 가이드를 통해 다음 리소스를 구축한다.

- **RDS MySQL**: 데이터베이스 (프라이빗 서브넷 배치)
- **ALB + Target Group**: 로드 밸런서
- **EC2 Auto Scaling Group**: 백엔드 인스턴스 (프라이빗 서브넷 배치, NAT 경유)
- **Bastion EC2**: Bastion 인스턴스 (퍼블릭 서브넷 배치, IGW 경유)
- **CodeDeploy Blue/Green**: 무중단 배포
- **GitHub Actions**: push 시 자동 배포 트리거

---

## 학습 흐름

```
git push
  ↓
GitHub Actions: 백엔드 zip 압축 → S3 업로드 → CodeDeploy 호출
  ↓
CodeDeploy: 신규 ASG 생성 → 신규 인스턴스에 코드 배포 → 헬스체크
  ↓
ALB 트래픽을 신규 ASG로 전환 → 기존 ASG는 5분 후 종료
  ↓
무중단 배포 완료
```

---

## 사전 준비 사항

### 1) VPC 및 Subnet

- VPC 1개
- **퍼블릭 서브넷 2개** (서로 다른 AZ. 예: `ap-northeast-2a`, `ap-northeast-2c`)
  - 인터넷 게이트웨이 연결, 라우팅 테이블 `0.0.0.0/0` → IGW
  - ALB 배치용
- **프라이빗 서브넷 2개 (svc)** (서로 다른 AZ)
  - **NAT Gateway 연결 필수** (라우팅 테이블 `0.0.0.0/0` → NAT)
  - EC2 백엔드 배치용
- **프라이빗 서브넷 2개 (db)** (서로 다른 AZ)
  - 인터넷 라우팅 없음
  - RDS 배치용

### 2) GitHub 저장소

저장소에 다음 파일이 커밋되어 있어야 한다.

```
.github/workflows/backend-deploy.yml
server.js
package.json
package-lock.json
init.sql
.env.example
appspec.yml
scripts/
├── before_install.sh
├── after_install.sh
├── application_start.sh
├── application_stop.sh
└── validate_service.sh
```

## 전체 단계 체크리스트

각 Part 완료 시 체크하여 진행 상황을 추적한다.

- [ ] **Part 1**. Security Group 3개 생성
- [ ] **Part 2**. RDS MySQL 생성
- [ ] **Part 3**. ALB 및 빈 Target Group 생성
- [ ] **Part 4**. S3 생성
- [ ] **Part 5**. IAM Role 및 Policy 구성
- [ ] **Part 6**. CI/CD 인프라 구축 (Launch Template, ASG, CodeDeploy)
- [ ] **Part 7**. GitHub repo Variables 등록
- [ ] **Part 8**. 첫 배포 (수동) 및 RDS 스키마 입력
- [ ] **Part 9**. 자동 배포 검증

---

# Part 1. Security Group 생성

Security Group 3개를 다음 순서대로 생성한다. 후속 SG가 선행 SG를 참조하므로 순서를 지켜야 한다.

순서: `alb-sg` → `backend-sg` → `rds-sg`

### 1-1. ALB Security Group

EC2 콘솔 > 좌측 메뉴 **Security Groups** > **Create security group**

| 항목 | 값 |
|---|---|
| Name | `alb-sg` |
| Description | ALB security group |
| VPC | 실습 VPC |

**Inbound rules**
- Type: `HTTP` / Port: `80` / Source: `Anywhere-IPv4` (`0.0.0.0/0`)

**Outbound rules**: 기본값 (모두 허용)

**Create security group** 클릭.

### 1-2. Backend Security Group

다시 **Create security group** 클릭.

| 항목 | 값 |
|---|---|
| Name | `backend-sg` |
| Description | Backend EC2 security group |
| VPC | 실습 VPC |

**Inbound rules**
- Type: `Custom TCP` / Port: `8080` / Source: `alb-sg` 검색하여 선택

**Outbound rules**: 기본값 유지 (모두 허용)

> ⚠️ Outbound를 좁게 설정하지 않는다. EC2가 NAT를 경유하여 다음 외부 서비스에 접근해야 한다.
> - apt 패키지 저장소 (HTTP 80)
> - Node.js 다운로드 (HTTPS 443)
> - CodeDeploy Agent 설치 파일 (HTTPS 443)
> - CodeDeploy 서비스 통신 (HTTPS 443)
> - npm registry (HTTPS 443)
>
> Outbound 차단 시 `CodeDeploy agent was not able to receive the lifecycle event` 오류가 발생한다.

**Create security group** 클릭.

### 1-3. RDS Security Group

| 항목 | 값 |
|---|---|
| Name | `rds-sg` |
| Description | RDS security group |
| VPC | 실습 VPC |

**Inbound rules**
- Type: `MYSQL/Aurora` / Port: `3306` / Source: `backend-sg` 검색하여 선택

**Outbound rules**: 기본값

**Create security group** 클릭.

### 검증

- EC2 > Security Groups에 3개 (`alb-sg`, `backend-sg`, `rds-sg`) 생성됨

---

# Part 2. RDS MySQL 생성

### 2-1. DB Subnet Group 생성

RDS 콘솔 > 좌측 메뉴 **Subnet groups** > **Create DB subnet group**

| 항목 | 값 |
|---|---|
| Name | `backend-db-subnet-group` |
| Description | Subnet group for backend RDS |
| VPC | 실습 VPC |
| Availability Zones | `ap-northeast-2a`, `ap-northeast-2c` 둘 다 체크 |
| Subnets | **프라이빗 서브넷 (db) 2개** 선택 |

**Create** 클릭.

### 2-2. RDS Instance 생성

RDS 콘솔 > **Databases** > **Create database**

**Engine 설정**
- Choose a database creation method: **Standard create**
- Engine type: **MySQL**
- Engine version: MySQL 8.0.x (기본값)
- Templates: **Free tier**

**Settings**

| 항목 | 값 |
|---|---|
| DB instance identifier | `guestbook-db` |
| Master username | `admin` |
| Master password | 영숫자 위주 16자 이상 |
| Confirm password | 동일 |

> ⚠️ DB 비밀번호는 Launch Template userdata의 heredoc 구문에 사용된다. 특수문자 중 `$`, `` ` ``, `\` 는 heredoc 문법 충돌을 일으키므로 사용을 피한다. `!`나 `?` 같은 일반 특수문자는 사용 가능.

**Instance configuration**
- DB instance class: `db.t3.micro`

**Storage**
- Storage type: General Purpose SSD (gp2 또는 gp3)
- Allocated storage: 20 GiB
- Storage autoscaling: 비활성화

**Connectivity**

| 항목 | 값 |
|---|---|
| Compute resource | Don't connect to an EC2 compute resource |
| VPC | 실습 VPC |
| DB subnet group | `backend-db-subnet-group` |
| Public access | **No** |
| VPC security group | Choose existing → `rds-sg` (기본 SG는 제거) |
| Availability Zone | `ap-northeast-2a` |
| Database port | `3306` |

**Database authentication**: Password authentication

**Monitoring**: Enhanced monitoring 비활성화

**Additional configuration** (펼쳐서 설정)

| 항목 | 값 |
|---|---|
| Initial database name | `guestbook` |
| Backup retention period | `0 days` |
| Encryption | 비활성화 |
| Auto minor version upgrade | 활성화 (기본값) |

**Create database** 클릭.

### 2-3. 생성 대기 및 엔드포인트 확인

생성 완료까지 5-10분 소요. 상태가 `Creating` → `Backing up` → `Available`로 진행된다.

`Available` 상태가 되면 RDS > Databases > `guestbook-db` 클릭 > **Connectivity & security** 탭에서 **Endpoint**를 확인하여 메모한다.

```
Endpoint: guestbook-db.cxxxxx.ap-northeast-2.rds.amazonaws.com
```

> 초기 스키마 적용은 Part 7에서 수행한다. 본 단계에서는 인스턴스 생성까지만 한다.

### 검증

- RDS Status: `Available`
- Endpoint 메모 완료
- DB 비밀번호 메모 완료

---

# Part 3. ALB 및 Target Group 생성

### 3-1. Target Group 생성

EC2 콘솔 > 좌측 **Target Groups** > **Create target group**

**Basic configuration**

| 항목 | 값 |
|---|---|
| Target type | **Instances** |
| Target group name | `backend-tg` |
| Protocol / Port | `HTTP` / `8080` |
| VPC | 실습 VPC |
| Protocol version | HTTP1 |

**Health checks**

| 항목 | 값 |
|---|---|
| Health check protocol | HTTP |
| Health check path | `/api/health` |

**Advanced health check settings** (펼쳐서 설정)

| 항목 | 값 |
|---|---|
| Port | Traffic port |
| Healthy threshold | `2` |
| Unhealthy threshold | `3` |
| Timeout | `5` seconds |
| Interval | `30` seconds |
| Success codes | `200` |

**Next** 클릭.

> ⚠️ Register targets 단계에서는 아무것도 등록하지 않고 바로 **Create target group** 클릭. ASG 생성 시 자동 등록된다.

### 3-2. ALB 생성

EC2 콘솔 > 좌측 **Load Balancers** > **Create load balancer** > **Application Load Balancer** > **Create**

**Basic configuration**

| 항목 | 값 |
|---|---|
| Load balancer name | `guestbook-alb` |
| Scheme | **Internet-facing** |
| IP address type | IPv4 |

**Network mapping**
- VPC: 실습 VPC
- Mappings: AZ 2개(`ap-northeast-2a`, `ap-northeast-2c`) 체크 후 각각 **퍼블릭 서브넷** 선택

**Security groups**
- 기본 SG 제거 후 `alb-sg` 선택

**Listeners and routing**
- Protocol / Port: `HTTP` / `80`
- Default action: Forward to → `backend-tg`

**Create load balancer** 클릭. 생성까지 2-3분 소요.

### 3-3. ALB DNS 확인

생성된 ALB > **Description** 탭에서 **DNS name**을 복사하여 메모.

예: `guestbook-alb-1234567890.ap-northeast-2.elb.amazonaws.com`

### 검증

- ALB Status: `Active`
- ALB DNS 메모 완료

---

# Part 4. S3 생성

### 4-1. S3 Artifact Bucket 생성

> ⚠️ 본 버킷 이름은 뒤에 생성할 5-4-1의 Policy에 입력해야함.

콘솔 > S3 > **Create bucket**

| 항목 | 값 |
|---|---|
| Bucket name | `devops-3tier-codedeploy-<본인id>` |
| AWS Region | `ap-northeast-2` |
| Object Ownership | ACLs disabled (기본값) |
| Block all public access | 모두 차단 (기본값 유지) |
| Bucket Versioning | **Enable** |
| Default encryption | 기본값 (SSE-S3) |

**Create bucket** 클릭.

# Part 5. IAM 구성

CI/CD 구동을 위해 IAM Role 3개와 OIDC Provider 1개가 필요하다.

| 항목 | 사용 주체 | 용도 |
|---|---|---|
| `EC2CodeDeployInstanceRole` | EC2 인스턴스 | S3 artifact 다운로드, SSM 접속 |
| `CodeDeployServiceRole` | CodeDeploy 서비스 | ASG/ALB/EC2 조작 |
| (OIDC Provider) | — | GitHub Actions 신뢰 관계 |
| `GithubActionsBackendDeployRole` | GitHub Actions | S3 업로드, CodeDeploy 트리거 |

### 5-1. EC2 Instance Profile 생성

콘솔 > IAM > **Roles** > **Create role**

**Step 1: Select trusted entity**
- Trusted entity type: **AWS service**
- Use case: **EC2**
- **Next** 클릭

**Step 2: Add permissions** — 다음 2개를 검색하여 체크.
- `AmazonEC2RoleforAWSCodeDeploy`
- `AmazonSSMManagedInstanceCore`

**Next** 클릭.

**Step 3: Name**
- Role name: `EC2CodeDeployInstanceRole`

**Create role** 클릭.

### 5-2. CodeDeploy Service Role 생성

콘솔 > IAM > **Roles** > **Create role**

**Step 1: Select trusted entity**
- Trusted entity type: **AWS service**
- Use case: **CodeDeploy** > **CodeDeploy**

> ⚠️ 'CodeDeploy - ECS' 또는 'CodeDeploy - Lambda'가 아닌 'CodeDeploy'를 선택한다.

**Next** 클릭. Permissions에 `AWSCodeDeployRole`이 자동 첨부된다.

추가로 다음 정책을 검색하여 체크한다.
- `AmazonEC2FullAccess`

**Next** 클릭.

**Step 3: Name**
- Role name: `CodeDeployServiceRole`

**Create role** 클릭.

#### Inline Policy 추가 (PassRole 권한)

> ⚠️ 본 단계 누락 시 첫 배포의 Step 1 (Provisioning replacement instances)에서 다음 오류가 발생한다. `The IAM role does not give you permission to perform operations in the following AWS service: AmazonAutoScaling.`

Blue/Green 배포 시 CodeDeploy가 신규 EC2 인스턴스에 Instance Profile(`EC2CodeDeployInstanceRole`)을 부착하기 위해 `iam:PassRole` 권한이 필요하다. `AWSCodeDeployRole`에는 포함되지 않으므로 별도로 추가한다.

방금 생성한 `CodeDeployServiceRole` 상세 페이지 > **Add permissions** > **Create inline policy** 클릭.

JSON 탭에서 다음 내용 입력 (`<ACCOUNT_ID>` 치환).

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": "iam:PassRole",
            "Resource": "arn:aws:iam::<ACCOUNT_ID>:role/EC2CodeDeployInstanceRole"
        }
    ]
}
```

**Next** 클릭. Policy name: `AllowPassEC2InstanceRole`. **Create policy** 클릭.

### 5-3. GitHub OIDC Provider 등록

GitHub Actions가 액세스 키 없이 IAM Role을 assume하기 위한 신뢰 관계 설정이다.

> ⚠️ AWS 계정당 1회만 등록한다. 이미 등록되어 있으면 본 단계는 생략한다.

콘솔 > IAM > **Identity providers** > **Add provider**

| 항목 | 값 |
|---|---|
| Provider type | **OpenID Connect** |
| Provider URL | `https://token.actions.githubusercontent.com` |
| Audience | `sts.amazonaws.com` |

**Add provider** 클릭.

### 5-4. GitHub Actions Backend Policy 및 Role 생성

#### 5-4-1. Policy 생성

> ⚠️ Policy 작성 전 S3 Artifact bucket 이름을 미리 결정한다. 권장 형식은 `devops-3tier-codedeploy-<본인id>`이다. S3 버킷 이름은 전역 유일해야 한다.

콘솔 > IAM > **Policies** > **Create policy** > JSON 탭

아래 JSON을 복사한 후 `<ARTIFACT_BUCKET>`, `<ACCOUNT_ID>` 부분을 실제 값으로 치환한다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3Upload",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:GetObjectVersion"
      ],
      "Resource": "arn:aws:s3:::<ARTIFACT_BUCKET>/*"
    },
    {
      "Sid": "S3List",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::<ARTIFACT_BUCKET>"
    },
    {
      "Sid": "CodeDeployTrigger",
      "Effect": "Allow",
      "Action": [
        "codedeploy:CreateDeployment",
        "codedeploy:GetDeployment",
        "codedeploy:GetDeploymentConfig",
        "codedeploy:RegisterApplicationRevision",
        "codedeploy:GetApplication",
        "codedeploy:GetApplicationRevision"
      ],
      "Resource": [
        "arn:aws:codedeploy:ap-northeast-2:<ACCOUNT_ID>:application:devops-3tier-backend",
        "arn:aws:codedeploy:ap-northeast-2:<ACCOUNT_ID>:deploymentgroup:devops-3tier-backend/devops-3tier-backend-bg",
        "arn:aws:codedeploy:ap-northeast-2:<ACCOUNT_ID>:deploymentconfig:*"
      ]
    }
  ]
}
```

**Next** 클릭. Policy name: `GithubActionsBackendDeployPolicy`. **Create policy** 클릭.

#### 5-4-2. Role 생성

콘솔 > IAM > **Roles** > **Create role**

**Step 1: Select trusted entity**
- Trusted entity type: **Web identity**
- Identity provider: `token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`
- GitHub organization: 본인 GitHub username만 입력 (예: `hojun121`)
- GitHub repository: 저장소 이름만 입력 (예: `devops-3-tier-practice`)
- GitHub branch: 비워두기

> ⚠️ organization 칸과 repository 칸에 GitHub URL 전체를 입력하지 않는다. URL을 입력하면 Trust policy의 `sub` 조건이 잘못 생성되어 OIDC 인증이 실패한다.

**Next** 클릭.

**Step 2: Add permissions**
- 검색창에 `GithubActionsBackendDeployPolicy` 입력 후 체크

**Next** 클릭.

**Step 3: Name**
- Role name: `GithubActionsBackendDeployRole`

**Create role** 클릭.

#### 5-4-3. Trust Relationship 확인

생성된 Role 클릭 > **Trust relationships** 탭에서 `sub` 조건을 확인한다.

올바른 형태:
```json
"token.actions.githubusercontent.com:sub": "repo:<github-username>/<repo-name>:*"
```

잘못된 형태(URL 입력 시):
```json
"token.actions.githubusercontent.com:sub": "repo:<github-username>/https://github.com/...:*"
```

잘못된 경우 **Edit trust policy** 버튼으로 수정.

#### 5-4-4. Role ARN 메모

상단의 **ARN**을 복사하여 메모.

형식: `arn:aws:iam::<ACCOUNT_ID>:role/GithubActionsBackendDeployRole`

### 검증

- IAM > Roles에 3개 Role 모두 생성됨
- `CodeDeployServiceRole`에 inline policy `AllowPassEC2InstanceRole` 첨부됨
- IAM > Identity providers에 `token.actions.githubusercontent.com` 등록됨
- `GithubActionsBackendDeployRole` Trust relationship의 `sub` 조건 정상
- `GithubActionsBackendDeployRole`의 ARN 메모 완료

---

# Part 6. CI/CD 인프라 구축

순서: Launch Template → ASG → CodeDeploy

### 6-1. Launch Template 생성

EC2 부팅 시 매번 실행될 userdata를 정의한다.

EC2 콘솔 > 좌측 **Launch Templates** > **Create launch template**

| 항목 | 값 |
|---|---|
| Launch template name | `backend-lt` |
| Template version description | `Initial version` (선택) |

**Application and OS Images**
- **Browse more AMIs** 클릭
- 사전에 메모한 Ubuntu 22.04 AMI ID 검색하여 선택

**Instance type**: `t3.micro`

**Key pair (login)**: "Don't include in launch template" (SSM Session Manager로 접속)

**Network settings**
- Subnet: **Don't include in launch template** (ASG에서 지정)
- **Auto-assign public IP**: **Disable** (프라이빗 서브넷 배치)
- Firewall (security groups): Select existing → `backend-sg`

**Configure storage**: 8 GiB / gp2 또는 gp3

**Advanced details** (펼쳐서 설정)

| 항목 | 값 |
|---|---|
| IAM instance profile | `EC2CodeDeployInstanceRole` |

**User data**: 페이지 하단. 아래 스크립트 전체를 복사한 뒤 `<RDS_엔드포인트>`, `<DB_PASSWORD>`를 실제 값으로 치환한다.

```bash
#!/bin/bash
set -e
exec > >(tee /var/log/userdata.log) 2>&1
echo "userdata started: $(date)"

# 1. 기본 패키지 설치
apt-get update -y
apt-get install -y ruby-full wget curl mysql-client

# 2. Node.js 20 설치
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 3. PM2 설치
npm install -g pm2

# 4. CodeDeploy Agent 설치 (ap-northeast-2)
cd /home/ubuntu
wget https://aws-codedeploy-ap-northeast-2.s3.ap-northeast-2.amazonaws.com/latest/install
chmod +x ./install
./install auto
systemctl enable codedeploy-agent
systemctl start codedeploy-agent

# 5. .env 작성 (DB 정보)
mkdir -p /home/ubuntu/backend
cat > /home/ubuntu/backend/.env << 'EOF'
PORT=8080
DB_HOST=<RDS_엔드포인트>
DB_PORT=3306
DB_USER=admin
DB_PASSWORD=<DB_PASSWORD>
DB_NAME=guestbook
EOF

chown -R ubuntu:ubuntu /home/ubuntu/backend
chmod 600 /home/ubuntu/backend/.env

echo "userdata completed: $(date)"
```

> ⚠️ `DB_HOST`에 RDS 엔드포인트 값만 입력한다. 대괄호 `[]`나 괄호 `()` 등을 포함하지 않는다.

**Create launch template** 클릭.

### 6-2. Auto Scaling Group 생성

EC2 콘솔 > 좌측 **Auto Scaling Groups** > **Create Auto Scaling group**

**Step 1: Choose launch template or configuration**
- Auto Scaling group name: `backend-asg`
- Launch template: `backend-lt` / Version: `Latest`
- **Next** 클릭

**Step 2: Choose instance launch options**
- VPC: 실습 VPC
- Availability Zones and subnets: **프라이빗 서브넷 (svc) a, c** 모두 선택
- **Next** 클릭

**Step 3: Configure advanced options**
- Load balancing: **Attach to an existing load balancer**
- Choose from your load balancer target groups: `backend-tg`
- VPC Lattice integration options: No VPC Lattice service
- **Health checks**:
  - Health check type: `Elastic Load Balancing` (체크박스 활성화)
  - Health check grace period: `300` seconds
- Additional settings: 기본값
- **Next** 클릭

> ⚠️ ELB 헬스체크 활성화는 Blue/Green 배포의 핵심이다. 미체크 시 ASG가 EC2 status check만으로 healthy 판단하여 애플리케이션이 비정상 상태여도 트래픽이 라우팅된다.

**Step 4: Configure group size and scaling**
- Desired capacity: `2`
- Minimum capacity: `2`
- Maximum capacity: `4`
- Scaling: **No scaling policies**
- **Next** 클릭

**Step 5: Add notifications** — 생략.

**Step 6: Review** — 확인 후 **Create Auto Scaling group** 클릭.

#### 결과 확인

생성 후 1-2분 후 EC2 콘솔에 신규 인스턴스 2개가 생성된다.

EC2 > Target Groups > `backend-tg` > **Targets** 탭에서 인스턴스 2개가 등록되었는지 확인.

> 초기 상태는 `unhealthy`로 표시된다. 애플리케이션이 배포되지 않아 `/api/health` 응답 불가 상태로 정상이다. 다음 단계의 CodeDeploy 배포 완료 후 `healthy`로 전환된다.

### 6-3. CodeDeploy Application 및 Deployment Group 생성

#### Application 생성

콘솔 > CodeDeploy > **Applications** > **Create application**

| 항목 | 값 |
|---|---|
| Application name | `devops-3tier-backend` |
| Compute platform | **EC2/On-premises** |

**Create application** 클릭.

#### Deployment Group 생성

생성한 Application 클릭 > **Create deployment group**

| 항목 | 값 |
|---|---|
| Deployment group name | `devops-3tier-backend-bg` |
| Service role | `CodeDeployServiceRole` |
| Deployment type | **Blue/green** |

**Environment configuration**
- **Automatically copy Amazon EC2 Auto Scaling group**
- Auto Scaling group: `backend-asg`

**Deployment configuration**
- Configuration: `CodeDeployDefault.AllAtOnce`

**Load balancer**
- Type: **Application Load Balancer**
- Choose target groups: `backend-tg`

**Deployment settings**
- Traffic rerouting: **Reroute traffic immediately**
- Original instances: **Terminate the original instances in the Auto Scaling group**
- Wait time: `0` days `0` hours `5` minutes

**Advanced** (펼쳐서 설정)
- Rollbacks: **Roll back when a deployment fails** 체크

**Create deployment group** 클릭.

### 검증

- ASG 인스턴스 2개 실행 중
- backend-tg에 등록됨 (현재 unhealthy 상태로 정상)
- CodeDeploy Application 및 Deployment Group 생성 완료

---

# Part 7. GitHub repo 설정

GitHub repo 페이지로 이동.

**Settings** > **Secrets and variables** > **Actions** > **Variables** 탭

> ⚠️ Secrets 탭이 아닌 **Variables** 탭이다.

다음 5개를 추가한다 (**New repository variable** 클릭).

| Name | Value |
|---|---|
| `AWS_REGION` | `ap-northeast-2` |
| `AWS_BACKEND_ROLE_ARN` | `arn:aws:iam::<ACCOUNT_ID>:role/GithubActionsBackendDeployRole` |
| `ARTIFACT_BUCKET` | `devops-3tier-codedeploy-<본인id>` |
| `CD_APP_NAME` | `devops-3tier-backend` |
| `CD_DG_NAME` | `devops-3tier-backend-bg` |

### 검증

Variables 탭에 5개 변수가 모두 등록되었는지 확인.

---

# Part 8. 첫 배포 (수동 트리거)

ASG 인스턴스에는 애플리케이션이 배포되지 않은 상태이다. 첫 배포로 코드를 적용한다.

### 8-1. Bastion 서버를 통한 RDS 스키마 적용 (1회 수행)

Bastion 서버에 접속 한 뒤 RDS에 스키마를 생성한다.

```bash
sudo apt update
sudo apt install -y mysql-client

# init.sql 적용
mysql -h <RDS_엔드포인트> -u admin -p guestbook < /home/ubuntu/backend/init.sql
# DB 비밀번호 입력

# 적용 확인
mysql -h <RDS_엔드포인트> -u admin -p guestbook -e "SHOW TABLES;"
# DB 비밀번호 입력
# messages 테이블이 출력되어야 정상
```

### 8-2. Workflow 수동 실행

GitHub repo > **Actions** 탭 > 좌측 메뉴에서 **Backend Deploy** 워크플로우 선택 > 우측 **Run workflow** 버튼 > Branch 선택 > **Run workflow** 클릭.

### 8-3. 진행 상황 확인

#### GitHub Actions 로그
- 실행된 workflow 클릭 > deploy job 클릭
- 다음 step이 순차 실행된다.
  1. Checkout
  2. Configure AWS credentials (OIDC)
  3. Package backend (zip 생성)
  4. Upload artifact to S3
  5. Trigger CodeDeploy
  6. Wait for deployment to complete (10-15분)

#### AWS CodeDeploy 콘솔
- CodeDeploy > Deployments > 진행 중 deployment 클릭
- 다음 단계가 순차 진행된다.
  1. **Step 1**: 신규 ASG 인스턴스 provisioning (3-5분)
  2. **Step 2**: 각 인스턴스에 ApplicationStop → BeforeInstall → Install → AfterInstall → ApplicationStart → ValidateService 순차 실행
  3. **Step 3**: ALB 트래픽을 신규 ASG로 전환
  4. **Step 4**: Original instances 종료 대기 (5분)
  5. **Step 5**: Original instances terminate

총 10-15분 소요. 성공 시 GitHub Actions의 'Wait for deployment' step도 정상 종료된다.

### 8-4. ALB 외부 접속 확인

로컬 터미널에서 다음을 실행한다.

```bash
# 헬스체크
curl http://<ALB_DNS>/api/health
# {"status":"ok","server":"ip-xxx-xxx-xxx-xxx",...}

# DB 헬스체크
curl http://<ALB_DNS>/api/health/db
# {"status":"ok","db":"connected","server":"ip-..."}

# 메시지 작성
curl -X POST http://<ALB_DNS>/api/messages \
  -H "Content-Type: application/json" \
  -d '{"name":"테스트","content":"첫 배포 성공"}'

# 메시지 조회
curl http://<ALB_DNS>/api/messages
```

여러 번 호출하여 server ID가 번갈아 표시되면 ALB 로드 밸런싱 정상 동작.

### 검증

- CodeDeploy deployment status: `Succeeded`
- backend-tg의 인스턴스 2개 모두 `healthy`
- ALB DNS로 `/api/health` 정상 응답
- 메시지 작성 및 조회 성공

---

# Part 9. 자동 배포 검증

backend 코드를 수정하여 자동 트리거 동작을 확인한다.

```bash
git checkout backend-cicd

# server.js의 console.log 메시지를 임의 변경
git add server.js
git commit -m "test: trigger auto deploy"
git push
```

GitHub Actions 탭에서 워크플로우가 자동 실행되었음을 확인.

10-15분 후 배포 완료. ALB DNS를 다시 호출한다.

```bash
curl http://<ALB_DNS>/api/health
```

`server` 필드의 인스턴스 ID가 신규 인스턴스 ID로 변경되었으면 성공.

### 검증

- 코드 push만으로 배포 자동 트리거 확인
- 배포 완료 후 ALB 응답에서 인스턴스 ID 변경 확인
- 다운타임 없음 (배포 진행 중에도 ALB 호출 시 정상 응답)

---

# 부록: 리소스 정리

실습 종료 후 리소스 정리는 생성과 반대 순서로 진행한다.

1. CodeDeploy Application 삭제 (Deployment Group 함께 삭제됨)
2. ASG 삭제 (인스턴스 자동 종료)
3. Launch Template 삭제
4. ALB 삭제
5. Target Group 삭제
6. RDS 인스턴스 삭제 (Final snapshot 거부)
7. DB Subnet Group 삭제
8. S3 Artifact Bucket 객체 모두 삭제 후 버킷 삭제
9. IAM Role 3개 삭제 (`EC2CodeDeployInstanceRole`, `CodeDeployServiceRole`, `GithubActionsBackendDeployRole`)
10. IAM Policy 삭제 (`GithubActionsBackendDeployPolicy`)
11. Security Group 3개 삭제 (`rds-sg` → `backend-sg` → `alb-sg` 순)
12. NAT Gateway, EIP, VPC, 서브넷 등 인프라
