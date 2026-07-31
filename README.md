# 백엔드 CI/CD 구축 실습 (Blue/Green)

이 실습에서는 백엔드 서버를 **Auto Scaling Group + CodeDeploy(Blue/Green)** 기반의 자동 배포 파이프라인으로 직접 구성해 봅니다.

네트워크 · RDS · ALB · S3 · CloudFront 등 기본 인프라는 CloudFormation 템플릿 하나로 올립니다(2단계). 단, **백엔드 EC2 계층만은 템플릿에 없습니다** — 그 빈자리에 Launch Template · Auto Scaling Group · CodeDeploy 기반의 자동 배포 파이프라인을 직접 구성해, 코드를 push하면 무중단으로 새 버전이 배포되는 흐름을 완성하는 것이 목표입니다.

```
git push  →  GitHub Actions  →  S3  →  CodeDeploy(Blue/Green)  →  Auto Scaling Group
```

> 진행 환경: AWS 리전 **서울(ap-northeast-2)**, 콘솔 기준.

---

## 1. 시작하기 — 브랜치 받기

먼저 작업 브랜치를 받습니다.

```bash
git fetch origin
git checkout backend-cicd
ls -A
```

폴더 구조는 다음과 같습니다.

```
backend-cicd/
├── 3tier-app-cloudformation-no-ec2.yaml   # 인프라 템플릿 (2단계에서 사용)
├── README.md                              # 이 문서
├── .github/
│   └── workflows/
│       └── backend-deploy.yml             # GitHub Actions 파이프라인
└── backend/                               # 배포되는 백엔드 애플리케이션
    ├── server.js                          # Express 방명록 API
    ├── package.json / package-lock.json
    ├── init.sql                           # DB 스키마 (참고용)
    ├── .env                               # 환경변수 예시 (실제 값은 서버가 직접 생성)
    ├── appspec.yml                        # CodeDeploy 배포 명세
    └── scripts/                           # 배포 단계별 실행 스크립트
        ├── before_install.sh
        ├── after_install.sh
        ├── application_start.sh
        ├── application_stop.sh
        └── validate_service.sh
```

---

## 2. 인프라 올리기 — CloudFormation 스택 생성

**`3tier-app-cloudformation-no-ec2.yaml`** 하나로 백엔드 EC2를 제외한 인프라 전체를 만듭니다.

- **네트워크** — VPC, 서브넷 6종 × 2AZ, AZ별 NAT Gateway 2개, S3 Gateway Endpoint
- **보안그룹 3개 (SG-to-SG 최소 개방)** — `ALB(80/443) → EC2(8080) → RDS(3306)` 체인. EC2의 80/443 아웃바운드(패키지 설치·CodeDeploy 에이전트·npm)만 추가로 열려 있습니다.
- **데이터** — RDS MySQL + 스키마 자동 초기화(Lambda)
- **입구** — ALB + **빈 타겟 그룹**(8080), CloudFront + 프론트엔드 S3(파일 자동 업로드)

백엔드 EC2 계층만 비어 있고, 그 자리는 이후 단계에서 Auto Scaling Group과 CodeDeploy로 채웁니다. 새로 만들 백엔드 EC2는 **프라이빗 서브넷**(`pri-svc-a/c`)에 배치됩니다.

### 진행

1. **CloudFormation → Create stack → With new resources (standard)**
2. *Template source* → **Upload a template file** → `3tier-app-cloudformation-no-ec2.yaml` 선택 → **Next**
3. Stack name: `guestbook` (다른 이름도 가능 — 리소스 이름에 접미사로 붙습니다) → 파라미터는 기본값 그대로 **Next → Next**
4. IAM 리소스 생성 동의 체크박스 ☑ → **Submit**
5. `CREATE_COMPLETE` (약 10~15분, RDS와 CloudFront가 오래 걸립니다) 후 **Outputs 탭의 값들을 메모**해 둡니다 — 이후 단계에서 계속 사용합니다.
6. Outputs의 `CloudFrontURL` 로 접속하면 방명록 페이지가 뜹니다.

> 이 시점에는 사이트의 `/api/*` 요청이 503으로 응답합니다. 백엔드가 아직 없어 타겟 그룹이 비어 있기 때문이며, 정상적인 상태입니다. 7단계(ASG)와 10단계(첫 배포)를 마치면 정상으로 돌아옵니다.

---

## 3. Blueprint Overview

본격적으로 만들기 전에, 무엇을 만드는지 한 번 짚고 갑니다.

### 아키텍처

```
사용자 → CloudFront (HTTPS)
   ├ 일반 요청(*) → S3 (정적 프론트엔드)
   └ /api/*       → ALB(:80, 퍼블릭) → 타겟 그룹 → 백엔드 EC2(:8080, 프라이빗) → RDS MySQL(:3306, 프라이빗)
                                                        ▲
                                            이번 실습에서 만드는 부분
```

백엔드 EC2는 **프라이빗 서브넷**(`pri-svc`)에 있어 인터넷에서 직접 접근할 수 없습니다. 서버가 밖으로 나가는 트래픽(패키지 설치 · CodeDeploy 에이전트 · S3 다운로드)은 AZ별 **NAT Gateway**(`pub-nat` 서브넷의 nat-a/nat-c)를 경유하고, 서버 접속은 SSH 대신 **SSM**으로 합니다(12단계 참고).

### 배포가 일어나는 순서 (Blue/Green)

```
코드 push (backend-cicd 브랜치)
   │
   ▼
GitHub Actions
   │  ① backend/ 폴더를 zip으로 묶음
   │  ② S3 버킷에 업로드
   │  ③ CodeDeploy에 배포 요청
   ▼
CodeDeploy (Blue/Green)
   │  · 지금 돌고 있는 그룹(Blue)을 복제해 새 그룹(Green)을 만든다
   │  · Green에 새 코드를 올리고 헬스체크(/api/health)로 정상 확인
   │  · 정상이면 트래픽을 Green으로 넘긴다
   │  · 기존 Blue는 종료한다
   ▼
무중단 배포 완료
```

핵심은 **새 버전을 별도 서버(Green)에 먼저 띄워 검증한 뒤 트래픽을 넘긴다**는 점입니다. 검증에 실패하면 기존 서버(Blue)가 그대로 서비스를 이어가므로 안전합니다.

### CodeDeploy 파이프라인을 구성하는 파일들

**`backend/appspec.yml`** — CodeDeploy에게 "코드를 어디에 풀고(`/home/ubuntu/backend`), 어떤 순서로 스크립트를 실행할지" 알려주는 명세서입니다. 실행 순서는 다음과 같습니다.

```
ApplicationStop → BeforeInstall → (파일 복사) → AfterInstall → ApplicationStart → ValidateService
```

**`backend/scripts/`** — 위 각 단계에서 실행되는 스크립트입니다.

| 스크립트 | 단계 | 하는 일 |
|---|---|---|
| `application_stop.sh` | ApplicationStop | 돌고 있던 서버 종료 (없으면 그냥 넘어감) |
| `before_install.sh` | BeforeInstall | 배포할 폴더 준비 |
| `after_install.sh` | AfterInstall | `.env` 확인 후 의존성 설치(`npm ci`) |
| `application_start.sh` | ApplicationStart | pm2로 서버 기동 |
| `validate_service.sh` | ValidateService | `/api/health` 로 정상 기동 확인 |

**`.github/workflows/backend-deploy.yml`** — `backend-cicd` 브랜치에 push하면 자동으로 도는 파이프라인입니다. AWS 인증(OIDC) → `backend/` 압축 → S3 업로드 → CodeDeploy 배포 요청 → 완료 대기 순으로 동작합니다.

### 앞으로 만들 것

다음 순서로 하나씩 만들어 갑니다.

- [ ] **S3** 배포 아티팩트 버킷 (4단계)
- [ ] **IAM** 역할 3개 (5단계)
- [ ] **Launch Template** (6단계)
- [ ] **Auto Scaling Group** (7단계)
- [ ] **CodeDeploy** 애플리케이션 + 배포 그룹 (8단계)
- [ ] **GitHub** 저장소 변수 (9단계)

---

## 4. S3 아티팩트 버킷 만들기

CodeDeploy가 가져갈 배포 파일(zip)을 보관할 버킷입니다.

1. **S3 → Create bucket**
2. 이름: 전 세계에서 겹치지 않게 (예: `guestbook-artifacts-<본인계정ID>`)
3. 리전: **ap-northeast-2**
4. *Block all public access* 는 **체크된 채로 그대로** → **Create**

만든 버킷 이름은 메모해 둡니다. 나중에 GitHub 변수 `ARTIFACT_BUCKET` 에 넣습니다.

---

## 5. IAM 역할 3개 만들기

### 5-1. 백엔드 서버용 역할

서버(EC2)에 붙는 역할입니다.

1. **IAM → Roles → Create role**
2. Trusted entity: **AWS service → EC2**
3. 정책 2개 연결
   - `AmazonSSMManagedInstanceCore` — SSM으로 서버 접속
   - `AmazonEC2RoleforAWSCodeDeploy` — CodeDeploy가 S3에서 배포 파일을 받을 수 있게 함
4. 이름: `backend-ec2-role` → 생성

### 5-2. CodeDeploy용 역할

CodeDeploy가 ASG와 로드밸런서를 다루고, Blue/Green 배포 때 **새로 띄우는 서버(Green)에 위 `backend-ec2-role` 을 붙일 수 있게** 해주는 역할입니다.

1. **IAM → Roles → Create role**
2. Trusted entity: **AWS service → CodeDeploy → CodeDeploy**
   - `CodeDeploy - ECS` 나 `CodeDeploy - Lambda` 가 아닌 **CodeDeploy** 를 고릅니다.
3. `AWSCodeDeployRole` 이 자동으로 붙습니다. 여기에 `AmazonEC2FullAccess` 도 검색해 **추가로 체크**합니다. Set Permissions boundary에서 "Use a permissions boundary to control the maximum role permissions" 체크하고 AmazonEC2FullAccess 검색해서 추가
<img width="1685" height="664" alt="image" src="https://github.com/user-attachments/assets/3174af74-7663-4744-ab6b-62f7a9268eae" />
4. 이름: `codedeploy-service-role` → 생성

이후, 생성된 'codedeploy-service-role' 검색해서 직접 들어가기
<img width="1701" height="538" alt="image" src="https://github.com/user-attachments/assets/6e8acb84-47f0-4ce3-b0b3-dcd154f37127" />

5. 생성된 역할에서 **Add permissions → Create inline policy → JSON** 으로 아래를 추가합니다.
<img width="2000" height="993" alt="image" src="https://github.com/user-attachments/assets/8111c3e3-544a-4465-a7d2-88ff6be15d6b" />


   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "iam:PassRole",
         "Resource": "arn:aws:iam::<ACCOUNT_ID>:role/backend-ec2-role"
       }
     ]
   }
   ```
<img width="1703" height="864" alt="image" src="https://github.com/user-attachments/assets/bce57345-3aa5-4f6d-b7be-bc0bcc1cdd15" />

   정책 이름: `AllowPassBackendEc2Role` → **Create policy**

> InlinePolicy 생성을 빼먹으면 **첫 배포의 첫 단계(새 서버 provisioning)** 에서 다음 오류로 멈춥니다.
> `The IAM role does not give you permission to perform operations in the following AWS service: AmazonAutoScaling`
> Blue/Green이 새로 띄우는 서버에 `backend-ec2-role` 을 붙이려면, CodeDeploy에게 "그 역할을 넘겨줘도 된다"는 `iam:PassRole` 권한이 필요합니다. `AWSCodeDeployRole` 에는 이 권한이 없어서 별도로 추가한겁니다!

### 5-3. GitHub Actions용 역할

GitHub Actions가 비밀 키 없이 AWS에 접근하도록 OIDC 방식으로 연결합니다.

**먼저 OIDC 공급자를 등록합니다.**

1. **IAM → Identity providers → Add provider**
2. Provider type: **OpenID Connect**
3. Provider URL: `https://token.actions.githubusercontent.com` → **Get thumbprint**
4. Audience: `sts.amazonaws.com` → **Add provider**

**이어서 역할을 만듭니다.**

1. **IAM → Roles → Create role → Web identity**
2. Identity provider: 방금 만든 GitHub OIDC, Audience: `sts.amazonaws.com`, GitHub organization: 여러분의 github userID
<img width="1704" height="889" alt="image" src="https://github.com/user-attachments/assets/a7e5e10f-ae6d-45cc-be55-1f3d18965860" />

3. `github-actions-backend-role` 이름으로 role 생성

4. 생성 이후  `github-actions-backend-role` 검색하여 **Permissions** 중 인라인 Policy 추가합니다. 
<img width="2000" height="1044" alt="image" src="https://github.com/user-attachments/assets/83946cc0-d432-4b6a-8352-3ceddb62583f" />
<img width="1698" height="891" alt="image" src="https://github.com/user-attachments/assets/b0713fe5-3b95-4df7-aa8a-f72e9ed34d7e" />

아래 JSON을 복사한 후 <ARTIFACT_BUCKET>, <ACCOUNT_ID> 부분을 실제 값으로 치환!
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
Next 클릭. Policy name: GithubActionsBackendDeployPolicy. Create policy 클릭.

---

## 6. Launch Template 만들기

Auto Scaling Group이 서버를 찍어낼 때 쓰는 틀입니다. 부팅 시 Node.js·pm2·CodeDeploy 에이전트를 설치하고 `.env` 파일만 만들어 둡니다. 실제 애플리케이션 코드는 CodeDeploy가 배포하므로 여기서 받지 않습니다.

1. **EC2 → Launch Templates → Create launch template**
2. 이름: `backend-lt`
3. AMI: **Ubuntu Server 24.04 LTS** (x86_64)
4. Instance type: `t3.micro`
5. Key pair: 없음 (SSM으로 접속)
6. Network settings
   - **Auto-assign public IP**: **Disable** — EC2는 프라이빗 서브넷(`pri-svc`)에 배치되어 퍼블릭 IP가 없습니다. 아웃바운드(Node.js · CodeDeploy 에이전트 · npm 다운로드)는 같은 AZ의 **NAT Gateway**를 경유하고, S3 아티팩트는 라우트 테이블에 붙은 **S3 Gateway Endpoint**로 내려받습니다. (항목이 안 보이면 *Advanced network configuration* 을 펼치면 있습니다.)
   - **Security groups**: `backend-sg` 선택 (Outputs의 `BackendSgId`)
   - 서브넷은 여기서 지정하지 않습니다. ASG가 정합니다.
7. Advanced details → **IAM instance profile**: `backend-ec2-role`
8. Advanced details → **User data** 에 아래 내용을 입력합니다. (중요) 아래 Script에서 <RDS_ENDPOINT> 는 RDS의 실제 Endpoint를 확인해서 넣어야합니다.

```bash
#!/bin/bash
set -xe
export DEBIAN_FRONTEND=noninteractive
apt-get update -y

# Node.js 20 + pm2
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs ruby-full wget
npm install -g pm2

# CodeDeploy 에이전트 (서울 리전)
cd /home/ubuntu
wget -q https://aws-codedeploy-ap-northeast-2.s3.ap-northeast-2.amazonaws.com/latest/install
chmod +x ./install
./install auto
systemctl enable codedeploy-agent
systemctl start codedeploy-agent

# 앱 폴더 + .env (CodeDeploy가 여기로 코드를 배포)
mkdir -p /home/ubuntu/backend
cat > /home/ubuntu/backend/.env <<EOF
PORT=8080
DB_HOST=<RDS_ENDPOINT>
DB_PORT=3306
DB_USER=admin
DB_PASSWORD=devops123!
DB_NAME=guestbook
EOF
chown -R ubuntu:ubuntu /home/ubuntu/backend
```

9. **Create launch template**

---

## 7. Auto Scaling Group 만들기

1. **EC2 → Auto Scaling Groups → Create**
2. 이름: `backend-asg`, Launch template: `backend-lt` → Next
3. Network: VPC(`VpcId`), 서브넷 **`pri-svc-a`, `pri-svc-c`** (`BackendSubnets`) → Next
4. **Load balancing**: *Attach to an existing load balancer* → *Choose from your load balancer target groups* → **`tg-...`** (`TargetGroupName`)
5. **Health checks**: **EC2** 선택, grace period `300`
6. Group size: Desired `2`, Min `2`, Max `4` → 생성

> 헬스체크를 ELB가 아닌 **EC2** 로 두는 이유가 있습니다. 첫 배포 전에는 서버에 아직 앱이 없어 `/api/health` 가 실패하는데, ELB 헬스체크로 두면 ASG가 이를 "고장"으로 보고 서버를 계속 새로 띄웠다 지웠다 반복합니다. EC2 헬스체크는 "서버가 켜져 있는지"만 보므로, 첫 배포 전까지 안정적입니다. (Blue/Green 전환 자체는 CodeDeploy가 타겟 그룹 상태로 판단하므로 영향받지 않습니다.)

서버 2대가 뜨고 위 User data 가 실행됩니다. 아직 앱이 없어서 타겟 그룹에는 unhealthy로 보이는데, 첫 배포 전까지는 정상입니다.

---

## 8. CodeDeploy 만들기 (Blue/Green)

1. **CodeDeploy → Applications → Create application**
   - 이름: `guestbook-backend`, Compute platform: **EC2/On-premises** → 생성
2. **Create deployment group**
   - 이름: `guestbook-backend-dg`
   - Service role: `codedeploy-service-role` (5-2)
   - Deployment type: **Blue/green**
   - Environment configuration: **Automatically copy Amazon EC2 Auto Scaling group** → `backend-asg`
   - Load balancer: **Enable** → Application Load Balancer → Target group: **`tg-...`**
   - Deployment settings
     - *Traffic rerouting*: **Reroute traffic immediately**
     - *Original instances*: 기존 서버를 일정 시간 뒤 종료 (예: 0~5분)
     - Deployment configuration: `CodeDeployDefault.AllAtOnce`
   - **Create deployment group**

애플리케이션 이름(`guestbook-backend`)과 배포 그룹 이름(`guestbook-backend-dg`)을 메모해 둡니다.

---

## 9. GitHub 저장소 변수 등록

저장소 **Settings → Secrets and variables → Actions → Variables** 탭에서 아래 5개를 등록합니다.

| 변수명 | 값 |
|---|---|
| `AWS_REGION` | `ap-northeast-2` |
| `AWS_BACKEND_ROLE_ARN` | 5-3에서 만든 Role ARN  |
| `ARTIFACT_BUCKET` | 4단계 버킷 이름 |
| `CD_APP_NAME` | `guestbook-backend` |
| `CD_DG_NAME` | `guestbook-backend-dg` |

5-3에서 만든 Role ARN => `github-actions-backend-role` 역할 ARN
<img width="2000" height="1043" alt="image" src="https://github.com/user-attachments/assets/5c60e2b2-3a30-4770-a275-e2c52a43c240" />

---

## 10. 첫 배포

두 가지 방법 중 하나로 파이프라인을 실행합니다.

- `backend-cicd` 브랜치에 커밋을 push, 또는
- **GitHub → Actions → Backend Deploy → Run workflow** (수동 실행)

진행 상황은 이렇게 따라가며 확인합니다.

- **GitHub Actions** 탭: 압축 → 업로드 → 배포 요청 → 완료 대기
- **CodeDeploy 콘솔**: Green 그룹 생성 → 배포 → 트래픽 전환 → Blue 종료
- **EC2 → Target Groups**: `tg-...` 가 **healthy** 로 바뀌는지 확인

---

## 11. 확인하기

1. Outputs의 **`CloudFrontURL`** 로 접속하면 방명록 페이지가 뜹니다.
2. 메시지를 남기고 새로고침했을 때 그대로 보이면 DB 저장이 정상입니다.
3. 새로고침을 반복했을 때 응답의 `server` 값(서버 이름)이 번갈아 바뀌면 로드밸런싱이 잘 동작하는 것입니다.
4. **직접 바꿔서 다시 배포해 보기**
   `backend/server.js` 의 `/api/health` 응답에 버전 표시 한 줄을 추가합니다.

   ```js
   app.get('/api/health', (req, res) => {
     res.status(200).json({
       status: 'ok',
       version: 'v2',        // ← 이 줄 추가
       server: SERVER_ID,
       ip: SERVER_IP,
       timestamp: new Date().toISOString(),
     });
   });
   ```

   저장 후 `backend-cicd` 브랜치에 push하면 파이프라인이 다시 돕니다. 배포가 끝난 뒤 브라우저에서 `https://<CloudFrontURL>/api/health` 에 접속하면 응답에 `version` 이 새로 나타납니다.
   - 배포 전: `{"status":"ok","server":...}`
   - 배포 후: `{"status":"ok","version":"v2","server":...}`

   이 `version` 필드가 새로 보이면 바꾼 코드가 CI/CD로 배포된 것입니다. Blue/Green으로 전환되는 동안에도 사이트는 끊김 없이 계속 동작합니다.

---

## 12. (부록) EC2 서버 접속하기 — SSM

백엔드 EC2는 프라이빗 서브넷에 있고 backend-sg 에 SSH(22) 인바운드도 없어, SSH 접속은 아예 불가능합니다. 대신 **SSM(Session Manager)** 으로 접속합니다. 필요한 준비는 이미 끝나 있습니다.

- SSM 에이전트: Ubuntu 24.04 AMI 에 기본 설치되어 있음
- 권한: 5-1 에서 `backend-ec2-role` 에 붙인 `AmazonSSMManagedInstanceCore`
- 네트워크: backend-sg 의 443 아웃바운드 → NAT 경유 (에이전트가 SSM 서비스로 폴링하는 구조라 인바운드가 필요 없음)

### 방법 1 — 콘솔에서 접속

1. **EC2 → Instances** 에서 인스턴스 선택 → **Connect**
2. **Session Manager** 탭 → **Connect**

브라우저에 바로 셸이 열립니다. 기본 사용자는 `ssm-user` 이므로, 앱 파일을 보려면 ubuntu 사용자로 전환합니다.

```bash
sudo su - ubuntu
pm2 list                  # 앱 프로세스 확인
ls /home/ubuntu/backend   # 배포된 코드 확인
```

### 방법 2 — 로컬에서 AWS CLI로 접속

로컬 PC에 [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)와 [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)이 설치되어 있고 자격 증명이 설정되어 있어야 합니다.

```bash
# 실행 중인 백엔드 서버의 인스턴스 ID 확인
aws ec2 describe-instances --region ap-northeast-2 \
  --filters "Name=instance-state-name,Values=running" "Name=tag:aws:autoscaling:groupName,Values=*backend-asg*" \
  --query "Reservations[].Instances[].InstanceId" --output text

# 셸 접속
aws ssm start-session --region ap-northeast-2 --target i-xxxxxxxxxxxxxxxxx
```

### 포트 포워딩 — 로컬에서 서버의 8080 열어보기

SSM 터널로 서버의 8080 포트를 내 PC 포트에 바인딩할 수 있습니다. SG 인바운드를 열지 않아도 됩니다 (443 아웃바운드 터널을 그대로 이용).

```bash
aws ssm start-session --region ap-northeast-2 --target i-xxxxxxxxxxxxxxxxx \
  --document-name AWS-StartPortForwardingSession \
  --parameters portNumber="8080",localPortNumber="8080"
```

세션이 열린 상태에서 브라우저로 `http://localhost:8080/api/health` 에 접속하면 ALB를 거치지 않고 해당 서버의 응답을 직접 확인할 수 있습니다. 특정 서버가 unhealthy 일 때 그 서버만 콕 집어 확인하는 용도로 유용합니다. 확인이 끝나면 터미널에서 `Ctrl+C` 로 세션을 종료합니다.

---

## 실습 후 정리

비용이 계속 나가지 않도록, 실습이 끝나면 만든 리소스를 아래 순서대로 삭제합니다. (NAT Gateway 2개, RDS, ALB, CloudFront, EC2가 모두 과금 대상입니다.)

콘솔에서 직접 만든 리소스를 먼저 지우고, **CloudFormation 스택을 가장 마지막에** 삭제하는 것이 핵심입니다. 순서가 꼬이면 스택 삭제가 실패하거나 리소스가 남을 수 있습니다.

1. **Auto Scaling Group 삭제**
   EC2 → Auto Scaling Groups 에서 `backend-asg` 와, CodeDeploy가 배포 과정에서 만든 `CodeDeploy_backend-asg_...` 를 **모두** 삭제합니다. ASG를 지우면 그 안의 서버(EC2)도 함께 종료됩니다.

2. **Launch Template 삭제**
   EC2 → Launch Templates 에서 `backend-lt` 를 삭제합니다.

3. **CodeDeploy 삭제**
   CodeDeploy → Applications 에서 `guestbook-backend` 를 삭제합니다. 배포 그룹 `guestbook-backend-dg` 도 함께 사라집니다.

4. **S3 아티팩트 버킷 삭제**
   S3 에서 `guestbook-artifacts-...` 버킷을 **Empty(비우기)** 한 뒤 **Delete** 합니다. 버킷은 비어 있어야 삭제됩니다.

5. **IAM 정리**
   IAM → Roles 에서 `backend-ec2-role`, `codedeploy-service-role`, `github-actions-backend-role` 을 삭제하고, IAM → Identity providers 에서 GitHub OIDC 공급자를 삭제합니다.

6. **(선택) GitHub 변수 삭제**
   저장소 Settings → Secrets and variables → Actions → Variables 에서 등록했던 5개 변수를 삭제합니다.

7. **CloudFormation 스택 삭제**
   마지막으로 스택을 **Delete** 하면 VPC · NAT · RDS · ALB · 프론트엔드 S3 · CloudFront 등 나머지 인프라가 한 번에 제거됩니다.

> ⚠️ 7번(스택 삭제)을 먼저 하지 마세요. ASG 서버가 스택의 타겟 그룹에 붙어 있는 상태에서 스택을 지우면 삭제가 막히거나 리소스가 남을 수 있습니다. 콘솔에서 직접 만든 1~5번을 먼저 정리해야 합니다.
