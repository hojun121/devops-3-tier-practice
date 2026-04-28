# 08. CI/CD 구축 (Backend, Blue/Green)

GitHub Actions로 백엔드를 **ASG + CodeDeploy Blue/Green** 방식으로 자동 배포한다.
`backend/**` 경로 변경이 main에 push되면 → S3 업로드 → 새 ASG 띄우기 → 헬스체크 → 트래픽 전환 → 옛 ASG 종료까지 자동.

> ⚠️ 이 docs를 따라가면 docs/02의 수동 EC2 운영(backend-a, backend-c 직접 SSH로 코드 올리기)은 ASG 기반으로 대체된다. docs/02는 학습 흔적으로 보존.

## 전체 흐름

```
git push (backend/** 변경)
  ↓
GitHub Actions: zip → S3 업로드 → CodeDeploy 트리거
  ↓
CodeDeploy: 기존 ASG 복제 → 새 EC2 부팅 (LT userdata 실행)
  ↓
새 인스턴스에서 ApplicationStop → BeforeInstall → AfterInstall(npm ci)
  → ApplicationStart(pm2) → ValidateService(/api/health)
  ↓
ALB 트래픽을 새 ASG로 전환
  ↓
[종료 대기 5분] ← 이 사이에 수동 롤백 가능
  ↓
옛 ASG terminate → 끝
```

총 소요 시간: 10-15분.

## 사전 확인

다음 값들을 미리 콘솔에서 확보해 메모.

| 항목 | 어디서 확인 |
|---|---|
| AWS 계정 ID (12자리) | IAM 콘솔 우상단 |
| RDS 엔드포인트 | RDS > Databases > 본인 DB > Connectivity |
| DB 비밀번호 | (본인이 알고 있는 값) |
| AMI ID (Ubuntu 22.04) | EC2 > backend-a 인스턴스 > Details > AMI ID |
| backend-sg ID | EC2 > Security Groups |
| pri-svc-a, pri-svc-c subnet ID | VPC > Subnets |
| backend-tg ARN | EC2 > Target Groups > backend-tg > Details |

---

## 1. EC2 Instance Profile 생성

ASG가 띄우는 EC2가 CodeDeploy agent로 S3에서 artifact를 받기 위함.

콘솔 > IAM > Roles > Create role

- Trusted entity type: **AWS service**
- Use case: **EC2**
- Permissions: `AmazonEC2RoleforAWSCodeDeploy` (managed policy)
- Role name: `EC2CodeDeployInstanceRole`

---

## 2. CodeDeploy Service Role 생성

CodeDeploy가 ASG/ALB를 조작할 때 사용.

콘솔 > IAM > Roles > Create role

- Trusted entity type: **AWS service**
- Use case: **CodeDeploy** > **CodeDeploy** (Blue/Green이 아닌 그냥 CodeDeploy 선택)
- Permissions: `AWSCodeDeployRole` (자동 첨부됨)
- Role name: `CodeDeployServiceRole`

---

## 3. GitHub Actions Backend Role 생성

OIDC Provider는 docs/07(Frontend)에서 이미 등록했으므로 건너뛰기. Role과 Policy만 추가.

### 3-1. Policy 생성

콘솔 > IAM > Policies > Create policy > JSON 탭

`<ARTIFACT_BUCKET>`, `<REGION>`, `<ACCOUNT_ID>` 부분을 본인 값으로 치환.

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
        "arn:aws:codedeploy:<REGION>:<ACCOUNT_ID>:application:devops-3tier-backend",
        "arn:aws:codedeploy:<REGION>:<ACCOUNT_ID>:deploymentgroup:devops-3tier-backend/devops-3tier-backend-bg",
        "arn:aws:codedeploy:<REGION>:<ACCOUNT_ID>:deploymentconfig:*"
      ]
    }
  ]
}
```

Policy name: `GithubActionsBackendDeployPolicy`

### 3-2. Role 생성

콘솔 > IAM > Roles > Create role

- Trusted entity type: **Web identity**
- Identity provider: `token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`
- GitHub organization: `hojun121`
- GitHub repository: `devops-3-tier-practice`
- 다음 화면에서 위에서 만든 `GithubActionsBackendDeployPolicy` 첨부
- Role name: `GithubActionsBackendDeployRole`

생성된 Role의 ARN 복사해 둠. (9단계에서 사용)

---

## 4. S3 Artifact Bucket 생성

콘솔 > S3 > Create bucket

- Bucket name: `devops-3tier-codedeploy-artifacts-hojun121` (전역 유니크 필요)
- Region: `ap-northeast-2`
- Block all public access: **유지** (체크된 그대로)
- Bucket Versioning: **Enable** (선택)
- 나머지 기본값

(선택) 생성 후 Lifecycle rule 추가 — 30일 후 객체 자동 만료. 오래된 zip이 쌓이지 않도록.

---

## 5. Launch Template 생성

가장 핵심적인 단계. 새 EC2가 부팅될 때마다 실행될 userdata 정의.

콘솔 > EC2 > Launch Templates > Create launch template

| 항목 | 값 |
|---|---|
| Launch template name | `backend-lt` |
| AMI | 사전 확인한 Ubuntu 22.04 AMI ID |
| Instance type | `t3.micro` |
| Key pair | `backend-key` |
| Network settings > Subnet | **Don't include in launch template** (ASG에서 지정) |
| Security groups | `backend-sg` |
| Storage | 8 GiB |
| Advanced > IAM instance profile | `EC2CodeDeployInstanceRole` |
| Advanced > User data | 아래 스크립트 |

### Userdata (전체 복사)

⚠️ `<RDS_엔드포인트>`, `<DB_PASSWORD>` 자리에 실제 값 채우기.

```bash
#!/bin/bash
set -e
exec > >(tee /var/log/userdata.log) 2>&1
echo "userdata started: $(date)"

# 1. 기본 패키지
apt-get update -y
apt-get install -y ruby-full wget curl

# 2. Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 3. PM2
npm install -g pm2

# 4. CodeDeploy Agent (ap-northeast-2)
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

⚠️ **userdata에 DB 비번 평문 노출**: `ec2:DescribeLaunchTemplateVersions` 권한 가진 IAM이면 누구나 볼 수 있다. 실습 계정에선 OK이지만 운영에선 SSM Parameter Store 또는 Secrets Manager로 옮겨야 한다.

---

## 6. (선택) Launch Template 동작 검증

LT 만들고 바로 ASG로 가기 전에, 단독 EC2 1대로 userdata가 잘 도는지 한 번 확인.

EC2 > Instances > Launch instances

- Use Launch Template: `backend-lt`, Latest version
- Subnet: `pri-svc-a`
- 1대 실행 (ASG와 무관, 검증용)

부팅 후 Bastion 경유로 SSH 접속해서:

```bash
sudo cat /var/log/userdata.log     # 에러 없는지
sudo cat /home/ubuntu/backend/.env # 파일 있고 내용 맞는지
sudo systemctl status codedeploy-agent  # active (running)
node -v                            # v20.x.x
pm2 -v
```

확인 후 검증용 인스턴스 terminate.

---

## 7. Auto Scaling Group 생성

콘솔 > EC2 > Auto Scaling Groups > Create

**Step 1**: Name = `backend-asg`, Launch template = `backend-lt` (Latest)

**Step 2**: Network
- VPC: 실습 VPC
- Availability Zones and subnets: `pri-svc-a`, `pri-svc-c`

**Step 3**: Load balancing + Health checks
- Attach to an existing load balancer
- Existing target group: `backend-tg`
- Turn on Elastic Load Balancing health checks: **체크** ⭐
- Health check grace period: `300` seconds

> "ELB 헬스체크 활성화"가 B/G의 핵심. 이걸 체크 안 하면 ASG가 EC2 status check만 보고 healthy 판단해서 앱이 죽었어도 트래픽이 들어간다.

**Step 4**: Group size
- Desired capacity: `2`
- Min: `2`
- Max: `4`
- Scaling: **No scaling policies** (이번 실습 범위 밖)

**Step 5-6**: 알람/알림 — 건너뛰기

**Step 7**: Tags
- Key: `Name`, Value: `backend-asg-instance` (선택)

Create Auto Scaling group.

생성 후 1-2분이면 새 EC2 2대가 뜨고 backend-tg에 자동 등록되어 healthy로 바뀐다.

⚠️ **이 시점에서 backend-tg에는 기존 backend-a/c + ASG 신규 2대 = 총 4대**가 등록된다. 11단계에서 정리.

---

## 8. CodeDeploy Application + Deployment Group

### 8-1. Application 생성

콘솔 > CodeDeploy > Applications > Create application

- Application name: `devops-3tier-backend`
- Compute platform: **EC2/On-premises**

### 8-2. Deployment Group 생성

생성한 Application 클릭 > Create deployment group

| 항목 | 값 |
|---|---|
| Deployment group name | `devops-3tier-backend-bg` |
| Service role | `CodeDeployServiceRole` |
| Deployment type | **Blue/green** ⭐ |
| Environment configuration | **Automatically copy Auto Scaling group** |
| Auto Scaling group | `backend-asg` |
| Deployment configuration | `CodeDeployDefault.AllAtOnce` |
| Load balancer | **Application Load Balancer** |
| Choose target groups | `backend-tg` |

**Deployment settings**
- Traffic rerouting: **Reroute traffic immediately**
- Original instances: **Terminate the original instances in the Auto Scaling group**
- Wait time: `0` days `0` hours `5` minutes

**Advanced > Rollbacks**
- Roll back when a deployment fails: **체크** ⭐

Create deployment group.

---

## 9. GitHub Variables 등록

GitHub repo > Settings > Secrets and variables > Actions > **Variables** 탭

새로 추가 (4개):

| Name | Value |
|---|---|
| `AWS_BACKEND_ROLE_ARN` | (3-2에서 만든 Role ARN) |
| `ARTIFACT_BUCKET` | `devops-3tier-codedeploy-artifacts-hojun121` |
| `CD_APP_NAME` | `devops-3tier-backend` |
| `CD_DG_NAME` | `devops-3tier-backend-bg` |

`AWS_REGION`은 docs/07(Frontend)에서 만든 것 그대로 재사용.

---

## 10. 첫 배포 (수동 트리거)

⚠️ ASG 인스턴스에는 아직 앱이 없다. 첫 배포로 앱 코드를 올린다.

GitHub > Actions > **Backend Deploy** 워크플로우 > Run workflow > 브랜치 `feature/cicd-backend` 또는 `main` > Run

진행 상황 확인:
- GitHub Actions 로그 (zip → S3 → CodeDeploy 트리거까지 약 1분)
- AWS CodeDeploy 콘솔 > Deployments > 진행 중 deployment (10-15분)

CodeDeploy 콘솔에서 단계별로 보임:
1. **Step 1**: 새 ASG에 인스턴스 provisioning (3-5분)
2. **Step 2**: BlockTraffic, ApplicationStop, BeforeInstall, Install, AfterInstall, ApplicationStart, ValidateService (각 인스턴스마다)
3. **Step 3**: ALB 트래픽 전환
4. **Step 4**: Original instances 종료 대기 (5분)
5. **Step 5**: Original instances terminate

성공 시 GitHub Actions의 "Wait for deployment" step도 success로 마무리.

---

## 11. 기존 EC2 (backend-a, backend-c) 정리

⚠️ 첫 배포 성공 + ALB 응답 정상 확인 후 진행.

### 11-1. Target Group에서 deregister

EC2 > Target Groups > `backend-tg` > Targets 탭
- backend-a, backend-c 선택 → **Deregister**

### 11-2. 5분 대기

deregister 후 connection draining (기본 5분) 완료까지 대기. 그 사이엔 옛 인스턴스로 신규 트래픽 안 가지만 진행 중인 요청은 처리.

### 11-3. EC2 terminate

EC2 > Instances > backend-a, backend-c 선택 → Terminate

이제 backend-tg에는 ASG 인스턴스만 남는다.

---

## 12. 자동 배포 검증

backend 코드를 의도적으로 수정해서 자동 트리거 확인.

```bash
git checkout main
git pull
# 예: server.js의 console.log 메시지 한 줄 변경
git add backend/
git commit -m "test: trigger auto deploy"
git push
```

GitHub Actions 탭에서 자동 실행 확인. 완료 후 ALB DNS로 호출:

```bash
curl http://<ALB_DNS>/api/health
```

`server` 필드의 인스턴스 ID가 새 인스턴스로 바뀌어 있으면 성공.

---

## 트러블슈팅

### 배포가 시작되지 않음
- CodeDeploy 콘솔 > Deployments에서 status 확인
- ASG 콘솔 > Activity 탭에서 인스턴스 launch 이벤트 있는지

### 새 인스턴스가 unhealthy로 빠짐 (가장 흔함)
SSM Session Manager 또는 Bastion으로 접속해 진단:

```bash
# userdata 로그
sudo cat /var/log/userdata.log

# CodeDeploy agent 로그
sudo tail -100 /var/log/aws/codedeploy-agent/codedeploy-agent.log

# 배포 hook 로그
sudo tail -100 /opt/codedeploy-agent/deployment-root/deployment-logs/codedeploy-agent-deployments.log

# 앱 로그
pm2 logs backend

# 직접 헬스체크
curl localhost:8080/api/health
```

### .env 관련 에러
- userdata에서 EOF까지 잘 작성됐는지 확인
- `sudo cat /home/ubuntu/backend/.env`로 내용 확인
- DB_HOST에 RDS 엔드포인트 오타 없는지

### ApplicationStop 단계에서 실패
- B/G 첫 배포에선 정상. 새 인스턴스에 PM2 자체가 없음
- `application_stop.sh`의 `|| true` 가드가 처리하므로 무시
- 만약 그래도 실패 표시되면 CodeDeploy 콘솔에서 events 확인

### 배포 진행 중 롤백하고 싶을 때
- CodeDeploy 콘솔 > 진행 중 Deployments > **Stop and roll back deployment**
- 트래픽이 즉시 옛 ASG로 복귀

### NAT Gateway 비용 ⚠️
- ASG 신규 인스턴스가 부팅마다 npm install 등 외부 트래픽 발생
- 기존 docs와 동일 — 실습 후 NAT Gateway 정리 필수

---

## 비용 요약

배포 중 잠깐:
- 인스턴스 2배 (5분간) — t3.micro 기준 무시할 수준
- S3 저장소: zip 파일 누적 (Lifecycle로 30일 만료 권장)

평소:
- ASG 인스턴스 2대 = 기존 backend-a/c와 동일
- 추가 비용 거의 없음

---

## 다음 단계 (선택)

- `09-https-acm-setup.md` — ACM 인증서 + ALB HTTPS 리스너
- CloudWatch Alarms 기반 자동 롤백
- DB 비번을 SSM Parameter Store로 마이그레이션
- ASG CPU 기반 스케일링 정책
