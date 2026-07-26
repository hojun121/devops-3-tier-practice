# 실습 2. Backend EC2 2대 구축 (pub-svc)

## 목표

- pub-svc 서브넷에 EC2 2대 생성 (AZ-a, AZ-c)
- 퍼블릭 IP 부여 방식 2가지 비교: `backend-a` = 자동 할당 / `backend-c` = EIP
- git clone으로 Backend 애플리케이션 배포

## Step 1. Backend 키 페어 생성

EC2 콘솔 → 키 페어 → 키 페어 생성

- 이름: `backend-key`
- `.pem` 다운로드
- `chmod 400 ~/Downloads/backend-key.pem`

## Step 2. Backend Security Group 생성

이름: `backend-sg`
VPC: 실습 VPC

**인바운드 규칙**

| 타입 | 포트 | 소스 | 설명 |
|---|---|---|---|
| SSH | 22 | `내 IP (My IP)` | 내 PC에서만 SSH |
| Custom TCP | 8080 | `alb-sg` | ALB에서 앱 접근 |

⚠️ SSH 소스는 반드시 **내 IP**로. `0.0.0.0/0`(전체 개방)은 절대 쓰지 말 것 — 퍼블릭 EC2는 인터넷에 그대로 노출되므로 22번 전체 개방 시 무차별 로그인 시도 대상이 됨.

⚠️ `alb-sg`는 실습 4(ALB)에서 만들 예정. 지금은 SSH만 넣고, ALB 만든 후 추가.

**아웃바운드**
기본값 (모두 허용) — 퍼블릭 IP + IGW 경로로 인터넷 통신 (npm install 등)

## Step 3. Backend EC2 생성 (2대)

### EC2 #1: backend-a — 퍼블릭 IP 자동 할당 방식

EC2 콘솔 → 인스턴스 시작

- 이름: `backend-a`
- AMI: Ubuntu Server 24.04 LTS
- 유형: `t3.micro`
- 키 페어: `backend-key`

**네트워크**
- VPC: 실습 VPC
- 서브넷: `pub-svc-a`
- 퍼블릭 IP 자동 할당: **활성화** ⭐
- Security Group: `backend-sg`

**스토리지**: 8 GiB

### EC2 #2: backend-c — EIP 방식

- 이름: `backend-c`
- 서브넷: `pub-svc-c`
- 퍼블릭 IP 자동 할당: **비활성화** ⭐ (Step 4에서 EIP를 직접 연결)
- 나머지(AMI, 유형, 키 페어, SG, 스토리지)는 backend-a와 동일

## Step 4. backend-c에 EIP 연결

backend-c는 퍼블릭 IP 자동 할당을 껐으므로, 지금은 인터넷에 못 나간다. EIP를 직접 붙여준다.

EC2 콘솔 → 탄력적 IP(Elastic IP) → 탄력적 IP 주소 할당

- EIP 1개 할당
- 할당한 EIP 선택 → 작업 → 탄력적 IP 주소 연결 → 인스턴스 `backend-c` 지정

### 자동 할당 vs 수동 EIP 할당 중요 차이점 

| 항목 | 퍼블릭 IP 자동 할당 (backend-a) | EIP (backend-c) |
|---|---|---|
| 주소 고정 여부 | 중지/시작 시 **IP 바뀜** | **고정** (해제·릴리스 전까지 유지) |

> 📌 **왜 둘 다 퍼블릭 IP가 꼭 있어야 하나?**
> IGW는 **퍼블릭 IP(또는 EIP)가 붙은 인스턴스에 대해서만 주소 변환(NAT)** 을 해준다. 퍼블릭 IP가 없으면 같은 public subnet에 있어도 IGW가 변환해줄 매핑이 없어 인터넷에 못 나간다. 즉 backend-c에 EIP를 안 붙이면 뒤의 `apt`, `git clone`이 timeout 난다.

> 💡 EIP는 **실행 중인 인스턴스에 연결돼 있으면 무료**, 할당만 해두고 연결 안 하면 과금된다. 실습 종료 시 연결 해제 후 **반드시 릴리스(release)** 할 것.

## Step 5. Backend 코드 배포 (git clone)

로컬에서 각 EC2로 SSH 접속:

```bash
# backend-a (자동 할당 퍼블릭 IP)
ssh -i ~/Downloads/backend-key.pem ubuntu@<backend-a_퍼블릭IP>

# backend-c (EIP)
ssh -i ~/Downloads/backend-key.pem ubuntu@<backend-c_EIP>
```

접속한 EC2에서 git으로 코드를 받는다 (backend-a, backend-c 각각):

```bash
# git 미설치 시
sudo apt update && sudo apt install -y git

cd ~
git clone https://github.com/hojun121/devops-3-tier-practice.git
cd devops-3-tier-practice/backend
```

> 이후 Step의 작업 디렉토리는 모두 `~/devops-3-tier-practice/backend` 기준이다.

## Step 6. 각 Backend EC2에서 설치

backend-a, backend-c 각각 접속 후:

```bash
cd ~/devops-3-tier-practice/backend
chmod +x start.sh
./start.sh
```

스크립트가 Node.js, npm, MySQL client, PM2를 설치합니다.

## 체크리스트

- [ ] Backend EC2 2대 생성 (pub-svc-a, pub-svc-c)
- [ ] backend-a 퍼블릭 IP 자동 할당 확인
- [ ] backend-c EIP 할당 + 연결 확인
- [ ] SSH 소스가 내 IP로 제한되어 있는지 확인
- [ ] 로컬 → Backend SSH 접속 성공
- [ ] `git clone` 완료
- [ ] Node.js 설치 완료 (`./start.sh`)
