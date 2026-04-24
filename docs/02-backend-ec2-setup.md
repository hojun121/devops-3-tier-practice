# 실습 2. Backend EC2 2대 구축 (pri-svc)

## 목표

- pri-svc 서브넷에 EC2 2대 생성 (AZ-a, AZ-c)
- Bastion 경유 SSH 접속
- Backend 애플리케이션 배포 준비

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
| SSH | 22 | `bastion-sg` | Bastion에서만 SSH |
| Custom TCP | 8080 | `alb-sg` | ALB에서 앱 접근 |

⚠️ `alb-sg`는 실습 4(ALB)에서 만들 예정. 지금은 SSH만 넣고, ALB 만든 후 추가.

**아웃바운드**
기본값 (모두 허용) — NAT 통해 인터넷 필요 (npm install 등)

## Step 3. Backend EC2 생성 (2대)

### EC2 #1: backend-a

EC2 콘솔 → 인스턴스 시작

- 이름: `backend-a`
- AMI: Ubuntu Server 22.04 LTS
- 유형: `t3.micro`
- 키 페어: `backend-key`

**네트워크**
- VPC: 실습 VPC
- 서브넷: `pri-svc-a`
- 퍼블릭 IP 자동 할당: **비활성화** ⭐
- Security Group: `backend-sg`

**스토리지**: 8 GiB

### EC2 #2: backend-c

동일한 방식으로 생성.
- 이름: `backend-c`
- 서브넷: `pri-svc-c`
- 나머지 동일

## Step 4. Bastion 경유 접속

### 방법 1. SSH Agent Forwarding (권장)

로컬 PC에서:

```bash
ssh-add ~/Downloads/backend-key.pem
ssh -A -i ~/Downloads/bastion-key.pem ubuntu@<Bastion_퍼블릭IP>
```

Bastion에서:

```bash
ssh ubuntu@<backend-a_프라이빗IP>
```

### 방법 2. Bastion에 키 복사

로컬에서:

```bash
scp -i ~/Downloads/bastion-key.pem \
    ~/Downloads/backend-key.pem \
    ubuntu@<Bastion_IP>:~/
```

Bastion에서:

```bash
chmod 400 ~/backend-key.pem
ssh -i ~/backend-key.pem ubuntu@<backend-a_프라이빗IP>
```

## Step 5. Backend 코드 배포

### 파일 업로드

로컬에서 (backend 디렉토리 전체를 Bastion으로):

```bash
scp -i ~/Downloads/bastion-key.pem -r \
    ./backend \
    ubuntu@<Bastion_IP>:~/
```

Bastion에서 backend EC2로:

```bash
scp -i ~/backend-key.pem -r \
    ./backend \
    ubuntu@<backend-a_IP>:~/

scp -i ~/backend-key.pem -r \
    ./backend \
    ubuntu@<backend-c_IP>:~/
```

### 각 Backend EC2에서 설치

backend-a, backend-c 각각 접속 후:

```bash
cd ~/backend
chmod +x start.sh
./start.sh
```

스크립트가 Node.js, npm, MySQL client, PM2를 설치합니다.

## Step 6. 환경변수 설정

각 Backend EC2에서:

```bash
cd ~/backend
cp .env.example .env
nano .env
```

`.env` 내용 수정 (RDS는 실습 3에서 만들 예정):

```
PORT=8080
DB_HOST=<RDS_엔드포인트>
DB_PORT=3306
DB_USER=admin
DB_PASSWORD=<RDS_암호>
DB_NAME=guestbook
```

## Step 7. 앱 실행 (RDS 생성 후)

```bash
cd ~/backend

# PM2로 실행
pm2 start server.js --name backend

# 상태 확인
pm2 status

# 로그 확인
pm2 logs backend

# 시스템 재부팅 시 자동 시작
pm2 startup
pm2 save
```

## Step 8. 로컬 테스트 (EC2 내부)

```bash
# 헬스체크
curl http://localhost:8080/api/health

# 응답 예시
# {"status":"ok","server":"ip-192-168-50-X","ip":"192.168.50.X",...}

# DB 헬스체크 (RDS 연결 후)
curl http://localhost:8080/api/health/db
```

## 체크리스트

- [ ] Backend EC2 2대 생성 (pri-svc-a, pri-svc-c)
- [ ] 퍼블릭 IP **없음** 확인
- [ ] Bastion → Backend SSH 접속 성공
- [ ] Node.js 설치 완료
- [ ] Backend 코드 업로드 완료
- [ ] `.env` 파일 생성 (RDS는 다음 실습에서)

## 트러블슈팅

**Bastion에서 Backend 접속 안 될 때**
- backend-sg에 Source가 `bastion-sg`인지 확인
- 실제로 backend-sg가 backend EC2에 붙어 있는지 확인

**npm install이 안 될 때**
- NAT Gateway가 동작 중인지 확인
- pri-svc의 라우팅 테이블에 `0.0.0.0/0 → nat-xxxx` 있는지
- `ping 8.8.8.8`이나 `curl https://google.com`으로 네트워크 테스트

**"npm: command not found"**
- `./start.sh` 실행했는지 확인
- 또는 수동 설치:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
  ```
