# Backend CI/CD 구축 가이드 (Blue/Green)

본 가이드를 통해 다음 리소스를 구축한다.

- **RDS MySQL**: 데이터베이스
- **ALB + Target Group**: 로드 밸런서
- **EC2 Auto Scaling Group**: 백엔드 인스턴스 (퍼블릭 서브넷 배치)
- **CodeDeploy Blue/Green**: 무중단 배포
- **GitHub Actions**: push 시 자동 배포 트리거

---

## 학습 흐름

```
git push
  ↓
GitHub Actions: backend zip 압축 → S3 업로드 → CodeDeploy 호출
  ↓
CodeDeploy: 신규 ASG 생성 → 신규 인스턴스에 코드 배포 → 헬스체크
  ↓
ALB 트래픽을 신규 ASG로 전환 → 기존 ASG는 5분 후 종료
  ↓
무중단 배포 완료
```

---

## 사전 준비 사항

다음 항목이 사전에 준비되어 있어야 한다.

### 1) VPC 및 Subnet

- VPC 1개 (CIDR 예: `192.168.0.0/16`)
- **퍼블릭 서브넷 2개** (서로 다른 AZ. 예: `ap-northeast-2a`, `ap-northeast-2c`)
  - 인터넷 게이트웨이 연결, 라우팅 테이블에 `0.0.0.0/0` → IGW 설정 완료
- **프라이빗 서브넷 2개** (서로 다른 AZ. RDS 배치용)
  - 인터넷 라우팅 없음

### 2) GitHub 저장소

백엔드 코드 저장소에 다음 파일이 커밋되어 있어야 한다.

```
.github/workflows/backend-deploy.yml
backend/
├── server.js
├── package.json
├── init.sql
├── .env.example
├── appspec.yml
└── scripts/
    ├── before_install.sh
    ├── after_install.sh
    ├── application_start.sh
    ├── application_stop.sh
    └── validate_service.sh
```

### 3) 사전 확인 정보

진행 중 사용할 값을 사전에 확인하여 메모한다.

| 항목 | 확인 위치 |
|---|---|
| AWS 계정 ID (12자리) | IAM 콘솔 우상단 |
| 리전 | `ap-northeast-2` (서울) |
| VPC ID | VPC > Your VPCs |
| 퍼블릭 서브넷 ID 2개 | VPC > Subnets |
| 프라이빗 서브넷 ID 2개 | VPC > Subnets |
| Ubuntu 22.04 AMI ID | 다음 절차 참고 |

#### Ubuntu 22.04 AMI ID 확인 방법

EC2 콘솔 > 좌측 메뉴 **AMIs** > 상단 필터를 **Public images**로 변경 > 검색창에 다음 입력.

```
ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server
```

검색 결과 중 Owner가 `099720109477` (Canonical 공식 계정)이며 생성일이 가장 최근인 AMI를 선택한다. AMI ID 형식은 `ami-0e9bfdb247cc8de84` 형태이다.

---

## 전체 단계 체크리스트

각 Part 완료 시 체크하여 진행 상황을 추적한다.

- [ ] **Part 1**. Security Group 3개 생성
- [ ] **Part 2**. RDS MySQL 생성
- [ ] **Part 3**. ALB 및 빈 Target Group 생성
- [ ] **Part 4**. IAM Role 및 Policy 구성
- [ ] **Part 5**. CI/CD 인프라 구축 (S3, Launch Template, ASG, CodeDeploy)
- [ ] **Part 6**. GitHub repo Variables 등록
- [ ] **Part 7**. 첫 배포 (수동) 및 RDS 스키마 입력
- [ ] **Part 8**. 자동 배포 검증

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
- Description: `Allow HTTP from anywhere`

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
- Type: `Custom TCP` / Port: `8080` / Source: **`alb-sg` 검색하여 선택**
- Description: `Allow 8080 from ALB only`

> ⚠️ Source 칸 클릭 시 SG 검색이 가능하다. `alb-sg`가 표시되지 않으면 1-1 단계가 정상 완료되었는지 확인한다.

**Outbound rules**: 기본값 유지 (npm install 등 외부 접속에 필요)

**Create security group** 클릭.

### 1-3. RDS Security Group

| 항목 | 값 |
|---|---|
| Name | `rds-sg` |
| Description | RDS security group |
| VPC | 실습 VPC |

**Inbound rules**
- Type: `MYSQL/Aurora` / Port: `3306` / Source: **`backend-sg` 검색하여 선택**
- Description: `Allow MySQL from backend only`

**Outbound rules**: 기본값

**Create security group** 클릭.

### 검증

EC2 > Security Groups에서 3개(`alb-sg`, `backend-sg`, `rds-sg`)가 모두 생성되었는지 확인한다.

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
| Subnets | **프라이빗 서브넷 2개** 선택 |

**Create** 클릭.

### 2-2. RDS Instance 생성

RDS 콘솔 > **Databases** > **Create database**

**Engine 설정**
- Choose a database creation method: **Standard create**
- Engine type: **MySQL**
- Engine version: MySQL 8.0.x (기본값 사용)
- Templates: **Free tier**

**Settings**

| 항목 | 값 |
|---|---|
| DB instance identifier | `guestbook-db` |
| Master username | `admin` |
| Master password | 16자 이상 강력한 비밀번호 |
| Confirm password | 동일 |

> ⚠️ DB 비밀번호는 Launch Template의 userdata에 사용되므로 반드시 메모해 둔다.

**Instance configuration**
- DB instance class: **db.t3.micro**

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

**Database authentication**: Password authentication (기본값)

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

생성 완료까지 5-10분 소요된다. 상태가 `Creating` → `Backing up` → `Available`로 진행된다.

`Available` 상태가 되면 RDS > Databases > `guestbook-db` 클릭 > **Connectivity & security** 탭에서 다음 정보를 확인한다.

```
Endpoint: guestbook-db.cxxxxx.ap-northeast-2.rds.amazonaws.com
Port: 3306
```

Endpoint를 메모한다. Part 5의 Launch Template userdata에서 사용된다.

### 2-4. 초기 스키마

RDS 인스턴스에 초기 스키마는 Part 7-3에서 적용한다. 본 단계에서는 별도 작업이 없다.

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

> ⚠️ Register targets 단계에서는 아무것도 등록하지 않고 바로 **Create target group**을 클릭한다. Auto Scaling Group 생성 시 자동 등록된다.

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

생성된 ALB > **Description** 탭에서 **DNS name**을 복사한다.

예: `guestbook-alb-1234567890.ap-northeast-2.elb.amazonaws.com`

### 검증

- ALB Status: `Active`
- Target Group 등록 인스턴스: 0개 (ASG 미생성 상태로 정상)
- ALB DNS 메모 완료

---

# Part 4. IAM 구성

CI/CD 구동을 위해 IAM Role 3개와 OIDC Provider 1개가 필요하다.

| 항목 | 사용 주체 | 용도 |
|---|---|---|
| `EC2CodeDeployInstanceRole` | EC2 인스턴스 | S3 artifact 다운로드, SSM 접속 |
| `CodeDeployServiceRole` | CodeDeploy 서비스 | ASG/ALB 조작 |
| (OIDC Provider) | — | GitHub Actions 신뢰 관계 |
| `GithubActionsBackendDeployRole` | GitHub Actions | S3 업로드, CodeDeploy 트리거 |

### 4-1. EC2 Instance Profile 생성

콘솔 > IAM > **Roles** > **Create role**

**Step 1: Select trusted entity**
- Trusted entity type: **AWS service**
- Use case: **EC2**
- **Next** 클릭

**Step 2: Add permissions** — 다음 2개를 검색하여 체크.
- `AmazonEC2RoleforAWSCodeDeploy` (S3 artifact 다운로드)
- `AmazonSSMManagedInstanceCore` (SSM Session Manager 접속)

**Next** 클릭.

**Step 3: Name**
- Role name: `EC2CodeDeployInstanceRole`

**Create role** 클릭.

### 4-2. CodeDeploy Service Role 생성

콘솔 > IAM > **Roles** > **Create role**

**Step 1: Select trusted entity**
- Trusted entity type: **AWS service**
- Use case: **CodeDeploy** > **CodeDeploy**

> ⚠️ 'CodeDeploy - ECS' 또는 'CodeDeploy - Lambda'가 아닌 'CodeDeploy'를 선택한다.

**Next** 클릭. Permissions에 `AWSCodeDeployRole`이 자동 첨부된다. 그대로 **Next**.

**Step 3: Name**
- Role name: `CodeDeployServiceRole`

**Create role** 클릭.

### 4-3. GitHub OIDC Provider 등록

GitHub Actions가 액세스 키 없이 IAM Role을 assume하기 위한 신뢰 관계 설정이다.

> ⚠️ AWS 계정당 1회만 등록한다. 이미 등록되어 있으면 본 단계는 생략한다.

콘솔 > IAM > **Identity providers** > **Add provider**

| 항목 | 값 |
|---|---|
| Provider type | **OpenID Connect** |
| Provider URL | `https://token.actions.githubusercontent.com` |
| Audience | `sts.amazonaws.com` |

**Add provider** 클릭.

### 4-4. GitHub Actions Backend Policy 및 Role 생성

#### 4-4-1. Policy 생성

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

치환 예시:
- `<ARTIFACT_BUCKET>` → `devops-3tier-codedeploy-hojun121`
- `<ACCOUNT_ID>` → `123456789012`

**Next** 클릭. Policy name: `GithubActionsBackendDeployPolicy`. **Create policy** 클릭.

#### 4-4-2. Role 생성

콘솔 > IAM > **Roles** > **Create role**

**Step 1: Select trusted entity**
- Trusted entity type: **Web identity**
- Identity provider: `token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`
- GitHub organization: 본인 GitHub username (예: `hojun121`)
- GitHub repository: 저장소 이름 (예: `devops-3-tier-practice`)
- GitHub branch: 비워두거나 `main` 입력

**Next** 클릭.

**Step 2: Add permissions**
- 검색창에 `GithubActionsBackendDeployPolicy` 입력 후 체크

**Next** 클릭.

**Step 3: Name**
- Role name: `GithubActionsBackendDeployRole`

**Create role** 클릭.

#### 4-4-3. Role ARN 확인

생성된 Role을 클릭하여 상단의 **ARN**을 복사한다.

형식: `arn:aws:iam::123456789012:role/GithubActionsBackendDeployRole`

### 검증

- IAM > Roles에 3개 Role 모두 생성됨 (`EC2CodeDeployInstanceRole`, `CodeDeployServiceRole`, `GithubActionsBackendDeployRole`)
- IAM > Identity providers에 `token.actions.githubusercontent.com` 등록됨
- `GithubActionsBackendDeployRole`의 ARN 메모 완료

---

# Part 5. CI/CD 인프라 구축

순서: S3 → Launch Template → ASG → CodeDeploy

### 5-1. S3 Artifact Bucket 생성

> ⚠️ 본 버킷 이름은 Step 4-4-1의 Policy에 작성한 이름과 정확히 일치해야 한다.

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

### 5-2. Launch Template 생성

본 가이드의 핵심 단계이다. EC2 부팅 시 매번 실행될 userdata를 정의한다.

EC2 콘솔 > 좌측 **Launch Templates** > **Create launch template**

| 항목 | 값 |
|---|---|
| Launch template name | `backend-lt` |
| Template version description | `Initial version` (선택) |

**Application and OS Images**
- **Browse more AMIs** 클릭
- 사전에 메모한 Ubuntu 22.04 AMI ID 검색하여 선택

**Instance type**
- `t3.micro`

**Key pair (login)**
- 기존 키 페어 선택 또는 "Don't include in launch template" 선택 (SSM Session Manager로 접속 가능)

**Network settings**
- Subnet: **Don't include in launch template** (ASG에서 지정)
- **Auto-assign public IP**: **Enable** (퍼블릭 서브넷 배치이므로 활성화 필수)
- Firewall (security groups): Select existing → `backend-sg`

**Configure storage**
- 8 GiB / gp2 또는 gp3

**Advanced details** (펼쳐서 설정)

| 항목 | 값 |
|---|---|
| IAM instance profile | `EC2CodeDeployInstanceRole` |

**User data**: 페이지 하단 위치. 아래 스크립트 전체를 복사한 뒤 `<RDS_엔드포인트>`, `<DB_PASSWORD>`를 실제 값으로 치환한다.

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

치환 예시:
- `<RDS_엔드포인트>` → `guestbook-db.cxxxxx.ap-northeast-2.rds.amazonaws.com`
- `<DB_PASSWORD>` → 실제 DB 비밀번호

**Create launch template** 클릭.

#### SSM Session Manager 접속

EC2 > Instances > 실행한 인스턴스 선택 > **Connect** 버튼 > **Session Manager** 탭 > **Connect**

> ⚠️ Connect 버튼이 비활성화된 경우 SSM agent가 아직 등록되지 않은 상태이다. 1-2분 후 새로고침한다.

쉘 접속 후 다음 항목을 확인한다.

```bash
# userdata 로그 확인
sudo cat /var/log/userdata.log
# 마지막 줄에 'userdata completed: ...' 출력이 있어야 한다.

# .env 파일 확인
sudo cat /home/ubuntu/backend/.env
# PORT, DB_HOST, DB_PASSWORD 등이 올바르게 작성되었는지 확인.

# CodeDeploy agent 상태
sudo systemctl status codedeploy-agent
# 'Active: active (running)' 상태여야 한다.

# Node 버전
node -v
# v20.x.x

# PM2 버전
pm2 -v
```

#### RDS 연결 테스트

```bash
mysql -h <RDS_엔드포인트> -u admin -p
# DB 비밀번호 입력 후 mysql 프롬프트가 표시되면 연결 성공.
exit
```

> ⚠️ 'Can't connect' 오류 발생 시 `rds-sg` 인바운드에 `backend-sg` 허용 규칙이 있는지 확인한다.

#### 검증용 인스턴스 종료

확인 후 EC2 > Instances > 인스턴스 선택 > **Instance state** > **Terminate**.

### 검증

- userdata 로그 정상 종료
- CodeDeploy agent 실행 상태 확인
- RDS 연결 성공
- 검증용 인스턴스 종료 완료

### 5-4. Auto Scaling Group 생성

EC2 콘솔 > 좌측 **Auto Scaling Groups** > **Create Auto Scaling group**

**Step 1: Choose launch template or configuration**
- Auto Scaling group name: `backend-asg`
- Launch template: `backend-lt` / Version: `Latest`
- **Next** 클릭

**Step 2: Choose instance launch options**
- VPC: 실습 VPC
- Availability Zones and subnets: **퍼블릭 서브넷 a**, **퍼블릭 서브넷 c** 모두 선택
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

> ⚠️ ELB 헬스체크 활성화는 Blue/Green 배포의 핵심이다. 미체크 시 ASG가 EC2 status check만으로 healthy 판단하여, 애플리케이션이 비정상 상태여도 트래픽이 라우팅된다.

**Step 4: Configure group size and scaling**
- Desired capacity: `2`
- Minimum capacity: `2`
- Maximum capacity: `4`
- Scaling: **No scaling policies**
- **Next** 클릭

**Step 5: Add notifications** — 생략, **Next** 클릭.

**Step 6: Review** — 확인 후 **Create Auto Scaling group** 클릭.

#### 결과 확인

생성 후 1-2분 후 EC2 콘솔에 신규 인스턴스 2개가 생성된다.

EC2 > Target Groups > `backend-tg` > **Targets** 탭에서 인스턴스 2개가 등록되었음을 확인한다.

> ⚠️ 초기 상태는 `unhealthy`로 표시된다. 애플리케이션이 배포되지 않아 `/api/health` 응답이 불가한 상태로 정상이다. 다음 단계(CodeDeploy 배포) 완료 후 `healthy` 상태로 변경된다.

### 5-5. CodeDeploy Application 및 Deployment Group 생성

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

# Part 6. GitHub repo 설정

GitHub repo 페이지로 이동한다.

### 6-1. Variables 등록

**Settings** > **Secrets and variables** > **Actions** > **Variables** 탭

> ⚠️ Secrets 탭이 아닌 Variables 탭이다. 두 탭은 별도 영역이므로 주의한다.

다음 5개를 추가한다 (**New repository variable** 클릭).

| Name | Value |
|---|---|
| `AWS_REGION` | `ap-northeast-2` |
| `AWS_BACKEND_ROLE_ARN` | `arn:aws:iam::<ACCOUNT_ID>:role/GithubActionsBackendDeployRole` |
| `ARTIFACT_BUCKET` | `devops-3tier-codedeploy-artifacts-<본인id>` |
| `CD_APP_NAME` | `devops-3tier-backend` |
| `CD_DG_NAME` | `devops-3tier-backend-bg` |

### 검증

Variables 탭에 5개 변수가 모두 등록되었는지 확인한다.

---

# Part 7. 첫 배포 (수동 트리거)

ASG 인스턴스에는 애플리케이션이 배포되지 않은 상태이다. 첫 배포로 코드를 적용한다.

### 7-1. Workflow 수동 실행

GitHub repo > **Actions** 탭 > 좌측 메뉴에서 **Backend Deploy** 워크플로우 선택 > 우측 **Run workflow** 버튼 > Branch: `main` (또는 작업 브랜치) > **Run workflow** 클릭.

### 7-2. 진행 상황 확인

#### GitHub Actions 로그
- 실행된 workflow 클릭 > deploy job 클릭
- 다음 step이 순차 실행된다.
  1. Checkout: 코드 체크아웃
  2. Configure AWS credentials (OIDC): 인증
  3. Package backend: zip 생성
  4. Upload artifact to S3: S3 업로드
  5. Trigger CodeDeploy: CodeDeploy 호출
  6. Wait for deployment to complete: 배포 완료 대기 (10-15분)

#### AWS CodeDeploy 콘솔
- CodeDeploy > Deployments > 진행 중 deployment 클릭
- 다음 단계가 순차 진행된다.
  1. **Step 1**: 신규 ASG에 인스턴스 provisioning (3-5분)
  2. **Step 2**: 각 인스턴스에 ApplicationStop → BeforeInstall → Install → AfterInstall → ApplicationStart → ValidateService 순차 실행
  3. **Step 3**: ALB 트래픽을 신규 ASG로 전환
  4. **Step 4**: Original instances 종료 대기 (5분)
  5. **Step 5**: Original instances terminate

총 10-15분 소요. 성공 시 GitHub Actions의 'Wait for deployment' step도 정상 종료된다.

### 7-3. RDS 스키마 입력 (1회 수행)

첫 배포 완료 후, ASG 인스턴스의 `/home/ubuntu/backend/init.sql`을 RDS에 적용한다.

EC2 > Instances > ASG가 실행한 인스턴스 1개 선택 > **Connect** > **Session Manager** > **Connect**

```bash
# init.sql을 RDS에 적용
mysql -h <RDS_엔드포인트> -u admin -p guestbook < /home/ubuntu/backend/init.sql
# DB 비밀번호 입력

# 적용 확인
mysql -h <RDS_엔드포인트> -u admin -p guestbook -e "SHOW TABLES;"
# DB 비밀번호 입력
# messages 테이블이 출력되어야 한다.
```

### 7-4. ALB 외부 접속 확인

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

여러 번 호출하여 server ID가 번갈아 표시되면 ALB 로드 밸런싱이 정상 동작하는 것이다.

### 검증

- CodeDeploy deployment status: `Succeeded`
- backend-tg의 인스턴스 2개 모두 `healthy`
- ALB DNS로 `/api/health` 정상 응답
- 메시지 작성 및 조회 성공

---

# Part 8. 자동 배포 검증

backend 코드를 수정하여 자동 트리거 동작을 확인한다.

```bash
git checkout main
git pull

# server.js의 console.log 메시지에 ' - v2' 등을 추가하는 등 임의 변경
git add backend/server.js
git commit -m "test: trigger auto deploy"
git push
```

GitHub Actions 탭에서 워크플로우가 자동 실행되었음을 확인한다.

10-15분 후 배포가 완료되면 ALB DNS를 다시 호출한다.

```bash
curl http://<ALB_DNS>/api/health
```

`server` 필드의 인스턴스 ID가 신규 인스턴스 ID로 변경되었으면 성공이다.

### 검증

- `backend/**` 변경사항 push만으로 배포 자동 트리거 확인
- 배포 완료 후 ALB 응답에서 인스턴스 ID 변경 확인
- 다운타임 없음 (배포 진행 중에도 ALB 호출 시 정상 응답)

---

# 트러블슈팅

## 배포가 시작되지 않음

**증상**: GitHub Actions의 'Trigger CodeDeploy' step 실패.

**원인**:
1. Variables 값 오타 (특히 ARN, 버킷 이름)
2. Policy의 Resource ARN 오타
3. OIDC trust 조건 오류

**확인 절차**:
- GitHub Actions 로그의 오류 메시지 상세 확인
- 'Could not assume role with OIDC' 메시지: Role의 Trust policy 확인
- 'AccessDenied' 메시지: Policy 첨부 여부 및 Resource ARN 확인

## 신규 인스턴스가 unhealthy 상태로 전환됨

가장 빈번한 사례이다.

**증상**: CodeDeploy의 ValidateService step 실패. 또는 backend-tg의 인스턴스가 unhealthy 상태.

**진단 절차**:

EC2 > Instances > 문제 인스턴스 선택 > Connect > Session Manager > Connect

```bash
# 1. userdata 로그
sudo cat /var/log/userdata.log
# 정상 종료 시 'userdata completed: ...'로 끝난다.

# 2. .env 파일
sudo cat /home/ubuntu/backend/.env
# DB_HOST, DB_PASSWORD가 올바르게 작성되었는지 확인.

# 3. CodeDeploy agent 로그
sudo tail -100 /var/log/aws/codedeploy-agent/codedeploy-agent.log

# 4. 배포 hook 로그 (구체적인 hook 실패 원인 확인)
sudo find /opt/codedeploy-agent/deployment-root/ -name "*.log" | xargs sudo tail -50

# 5. 애플리케이션 기동 상태
pm2 list
pm2 logs backend --lines 50

# 6. 애플리케이션 응답 확인
curl localhost:8080/api/health
# 응답 실패 시 애플리케이션이 정상 기동되지 않은 상태. pm2 logs로 오류를 확인한다.
```

## .env 관련 오류

- userdata의 `cat > .env << 'EOF'` 구문이 올바른지 확인
- placeholder가 실제 값으로 치환되었는지 확인
- DB 비밀번호에 특수문자가 포함되면 heredoc 문법 오류 가능성. 영숫자 위주 사용 권장.

## ApplicationStop 단계 실패

Blue/Green 첫 배포에서 발생하는 정상 동작이다. 신규 인스턴스에 PM2가 설치되지 않은 상태이기 때문이다.

`application_stop.sh`의 `|| true` 가드로 처리된다. 오류 표시가 지속되면 후속 hook의 정상 실행 여부를 확인한다.

## RDS 연결 실패

**증상**: 애플리케이션은 기동되었으나 `/api/health/db` 호출 시 500 오류 발생. 또는 mysql 클라이언트 직접 연결 실패.

**확인 항목**:
1. `rds-sg` 인바운드에 `backend-sg`(포트 3306) 허용 규칙 존재 여부
2. RDS의 VPC SG가 `rds-sg`로 설정되어 있는지
3. RDS Endpoint와 .env의 DB_HOST 일치 여부
4. DB 비밀번호 일치 여부
5. RDS Status가 `Available` 상태인지

## ALB 응답 502 / 503

- **502**: Target 응답 실패 (애플리케이션 비정상 종료, 타임아웃)
  - backend-tg 인스턴스가 unhealthy 상태인 경우 위 항목 참고
- **503**: Healthy target 0개
  - ASG 인스턴스가 모두 unhealthy 상태
  - 또는 Target Group에 등록되지 않음

## 배포 진행 중 롤백

CodeDeploy 콘솔 > 진행 중 Deployments 클릭 > 우측 상단 **Stop and roll back deployment** 버튼.

트래픽이 이전 ASG로 즉시 복귀한다.

## SSM Session Manager 접속 실패

**Connect 버튼 비활성**:
- 인스턴스 부팅 직후 (1-2분 추가 대기 필요)
- IAM Instance Profile에 `AmazonSSMManagedInstanceCore` 정책 미첨부
- 인스턴스 인터넷 접속 불가 (퍼블릭 IP 미할당 또는 라우팅 테이블에 IGW 누락)

**확인 항목**:
- 인스턴스 Details의 IAM role이 `EC2CodeDeployInstanceRole`인지 확인
- `EC2CodeDeployInstanceRole`의 Permissions에 `AmazonSSMManagedInstanceCore` 첨부 여부
- 인스턴스의 Public IPv4 address 할당 여부

## CodeDeploy Agent 비정상 종료

**증상**: 배포 진행이 중단되어 timeout 발생.

```bash
sudo systemctl status codedeploy-agent
# 비정상 종료 상태인 경우 재시작
sudo systemctl restart codedeploy-agent
```

**원인**: userdata의 agent 설치/시작 단계 실패. `/var/log/userdata.log`를 확인한다.

---

# 다음 단계로 배울 것들

- **HTTPS 도입**: ACM 인증서 발급 및 ALB HTTPS 리스너 추가
- **Frontend CI/CD**: S3 + CloudFront 자동 배포 (별도 가이드 참조)
- **CloudWatch Alarms 기반 자동 롤백**: 5xx 오류율 임계치 초과 시 자동 롤백
- **DB 비밀번호 SSM Parameter Store 마이그레이션**: userdata 평문 노출 제거
- **ASG CPU 기반 스케일링 정책**: 트래픽 증가 시 자동 인스턴스 추가

---

# 부록: 리소스 정리

실습 종료 후 리소스 정리는 생성과 반대 순서로 진행한다.

1. CodeDeploy Application 삭제 (Deployment Group까지 함께 삭제됨)
2. ASG 삭제 (인스턴스 자동 종료)
3. Launch Template 삭제
4. ALB 삭제
5. Target Group 삭제
6. RDS 인스턴스 삭제 (Final snapshot 거부 옵션 선택)
7. DB Subnet Group 삭제
8. S3 Artifact Bucket 객체 삭제 후 버킷 삭제
9. IAM Role 3개 삭제 (`EC2CodeDeployInstanceRole`, `CodeDeployServiceRole`, `GithubActionsBackendDeployRole`)
10. IAM Policy 삭제 (`GithubActionsBackendDeployPolicy`)
11. Security Group 3개 삭제 (`rds-sg` → `backend-sg` → `alb-sg` 순)
13. NAT Gateway, EIP, VPC, 서브넷 등 인프라
