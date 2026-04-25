# 실습 3. RDS MySQL 구축 (pri-db)

## 목표

- pri-db 서브넷에 RDS MySQL 생성
- Bastion/Backend에서 접속 확인
- 테이블 초기화

## Step 1. DB Subnet Group 생성

RDS 콘솔 → Subnet groups → Create DB subnet group

- 이름: `guestbook-db-subnet-group`
- VPC: 실습 VPC
- Availability Zones: `ap-northeast-2a`, `ap-northeast-2c`
- Subnets: `pri-db-a`, `pri-db-c` 선택

## Step 2. RDS Security Group 생성

이름: `rds-sg`
VPC: 실습 VPC

**인바운드 규칙**

| 타입 | 포트 | 소스 | 설명 |
|---|---|---|---|
| MySQL/Aurora | 3306 | `backend-sg` | Backend EC2에서 접근 |
| MySQL/Aurora | 3306 | `bastion-sg` | Bastion에서 관리 접근 |

## Step 3. RDS 인스턴스 생성

RDS 콘솔 → 데이터베이스 생성

**엔진 옵션**
- 엔진: MySQL
- 버전: MySQL 8.0.x (최신 안정판)

**템플릿**
- 프리 티어 (실습용)

**설정**
- DB 인스턴스 식별자: `guestbook-db`
- 마스터 사용자: `admin`
- 마스터 암호: (안전하게 보관!)

**인스턴스 구성**
- `db.t3.micro` (프리 티어)

**스토리지**
- 범용 SSD (gp2)
- 할당 스토리지: 20 GiB
- 스토리지 자동 조정: 비활성화 (실습)

**연결**
- VPC: 실습 VPC
- DB Subnet Group: `guestbook-db-subnet-group`
- 퍼블릭 액세스: **아니오** ⭐ 중요
- VPC Security Group: `rds-sg`
- AZ: `ap-northeast-2a`

**추가 구성**
- 초기 데이터베이스 이름: (공란 — SQL로 생성)
- 백업 보관 기간: 1일 (실습)
- 자동 백업 창: 기본값
- 유지 관리: 기본값

생성까지 약 5~10분 소요.

## Step 4. 엔드포인트 확인

RDS 콘솔 → DB 인스턴스 → `guestbook-db` 클릭 → **엔드포인트** 복사

예시:
```
guestbook-db.xxxxxxxxxx.ap-northeast-2.rds.amazonaws.com
```

## Step 5. Bastion에서 MySQL 접속

Bastion 접속 후 MySQL 클라이언트 설치:

```bash
sudo apt update
sudo apt install -y mysql-client
```

RDS에 접속:

```bash
mysql -h <RDS_엔드포인트> -u admin -p
```

암호 입력 후 MySQL 프롬프트 진입:

```
mysql>
```

## Step 6. 데이터베이스 초기화

Backend 디렉토리의 `init.sql` 실행:

**방법 1. MySQL 프롬프트에서 직접 실행**

```sql
CREATE DATABASE IF NOT EXISTS guestbook
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE guestbook;

CREATE TABLE IF NOT EXISTS messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO messages (name, content) VALUES
  ('관리자', 'AWS 3-Tier 실습 환영!'),
  ('테스터', '메시지를 작성하면 DB에 저장됩니다.');

SELECT * FROM messages;
```

**방법 2. 파일로 실행**

Bastion에 `init.sql` 업로드 후:

```bash
mysql -h <RDS_엔드포인트> -u admin -p < init.sql
```

## Step 7. Backend EC2에서 연결 테스트

Backend EC2 접속 후:

```bash
# MySQL client로 직접 접속 테스트
mysql -h <RDS_엔드포인트> -u admin -p -e "SHOW DATABASES;"

# .env 업데이트
cd ~/backend
nano .env
```

`.env` 업데이트:

```
PORT=8080
DB_HOST=guestbook-db.xxxxxxxxxx.ap-northeast-2.rds.amazonaws.com
DB_PORT=3306
DB_USER=admin
DB_PASSWORD=<실제_암호>
DB_NAME=guestbook
```

## Step 8. Backend 실행

```bash
cd ~/backend
pm2 start server.js --name backend
pm2 logs backend
```

로그에서 확인:
```
Server starting: ip-192-168-50-X (192.168.50.X)
DB connected successfully
Backend server ip-192-168-50-X running on port 8080
```

## Step 9. API 테스트

Backend EC2 내에서:

```bash
# 헬스체크
curl http://localhost:8080/api/health

# DB 헬스체크
curl http://localhost:8080/api/health/db

# 메시지 목록
curl http://localhost:8080/api/messages

# 메시지 작성
curl -X POST http://localhost:8080/api/messages \
  -H "Content-Type: application/json" \
  -d '{"name":"테스트","content":"Hello from EC2"}'
```

두 Backend EC2 모두에서 같은 데이터가 조회되는지 확인!
→ DB 공유 동작 증명

## 체크리스트

- [ ] DB Subnet Group이 pri-db-a, pri-db-c에 걸쳐있음
- [ ] RDS 퍼블릭 액세스 "아니오" 확인
- [ ] RDS SG가 backend-sg, bastion-sg의 3306 허용
- [ ] Bastion에서 RDS 접속 성공
- [ ] guestbook DB와 messages 테이블 생성 완료
- [ ] Backend EC2 2대 모두에서 DB 연결 성공
- [ ] API 테스트 모두 통과

## 트러블슈팅

**RDS 접속이 안 될 때**
- RDS SG에 Source가 `bastion-sg`/`backend-sg`인지 확인
- 포트 3306 열려 있는지
- RDS와 EC2가 같은 VPC인지

**`Can't connect to MySQL server`**
- 엔드포인트 주소 정확한지
- 포트 3306 맞는지
- 네트워크 확인: `telnet <엔드포인트> 3306`

**암호 오류**
- 마스터 암호 재확인
- 특수문자가 shell에 먹힐 수 있으니 `-p` 뒤에 암호 넣지 말고 프롬프트에서 입력

**`Unknown database 'guestbook'`**
- init.sql 실행했는지 확인
- `SHOW DATABASES;`로 존재 여부 확인

## 비용 주의 ⚠️

- RDS는 **생성 즉시 과금 시작**
- 프리 티어라도 다중 인스턴스 띄우면 과금
- 실습 끝나면 **반드시 삭제**:
  - 스냅샷 유지 옵션 선택 여부 확인
  - "최종 스냅샷 없이 삭제" 권장 (실습용)
