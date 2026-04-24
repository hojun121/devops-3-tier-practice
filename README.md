# DevOps 3-Tier Practice

AWS 3-Tier 아키텍처 실습용 방명록 애플리케이션

## 아키텍처

```
사용자
  ↓
CloudFront (CDN)
  ↓              ↓
S3 (Frontend)   ALB
                 ↓
               EC2 × 2 (Backend, pri-svc)
                 ↓
               RDS MySQL (pri-db)

* Bastion (pub-svc) → 프라이빗 EC2 SSH 접속용
```

## 기술 스택

### Frontend
- 순수 HTML + CSS + JavaScript (빌드 없음)
- S3 정적 웹 호스팅

### Backend
- Node.js 20 + Express
- MySQL2 (DB 드라이버)
- PM2 (프로세스 매니저)

### Database
- AWS RDS MySQL 8.0

## 디렉토리 구조

```
devops-3-tier-practice/
├── README.md
├── frontend/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── backend/
│   ├── server.js
│   ├── package.json
│   ├── init.sql
│   ├── start.sh
│   └── .env.example
└── docs/
    ├── 01-bastion-setup.md
    ├── 02-backend-ec2-setup.md
    ├── 03-rds-setup.md
    ├── 04-alb-setup.md
    ├── 05-frontend-s3-setup.md
    └── 06-cloudfront-setup.md
```

## 실습 순서

1. VPC 구축 (별도 완료)
2. Bastion 구축 (pub-svc)
3. Backend EC2 2대 구축 (pri-svc)
4. RDS MySQL 구축 (pri-db)
5. ALB 구축 및 연결 (pub-elb)
6. Frontend S3 배포
7. CloudFront 연결
8. 리소스 정리

## 주요 확인 포인트

### 로드밸런싱 동작 확인
- 프론트엔드에서 `응답한 서버: ip-xxx-xxx` 표시
- 새로고침 시 서버 ID 변경 확인 → ALB 동작 증명

### 장애 시뮬레이션
- EC2 1대 중지 → ALB가 건강한 EC2로만 트래픽 전달
- 서비스 지속 확인

### DB 공유 확인
- EC2 A에서 작성한 메시지 → EC2 B 응답에도 표시
- 두 EC2가 같은 RDS 공유 확인

## 비용 주의

실습 후 반드시 정리할 리소스:
- NAT Gateway (시간 + 트래픽 요금)
- ALB (시간 요금)
- RDS (시간 요금)
- EC2 (시간 요금)
- Elastic IP (미사용 시 과금)
