# 실습 6. CloudFront 연결

## 목표

- CloudFront Distribution 생성
- S3 (Frontend) + ALB (Backend API)를 Origin으로
- OAC로 S3 보호
- Behavior로 경로 기반 라우팅
- HTTPS 접속 테스트

## Step 1. Frontend 코드 수정

CloudFront는 같은 도메인에서 `/`는 S3로, `/api/*`는 ALB로 보내줌.
이제 상대 경로로 API 호출 가능:

`frontend/app.js`:

```javascript
// 기존: const API_BASE = 'http://<ALB_DNS>/api';
const API_BASE = '/api';
```

S3에 업로드:

```bash
aws s3 cp frontend/app.js s3://guestbook-frontend-hojun121/
```

또는 콘솔에서 파일 덮어쓰기.

## Step 2. CloudFront Distribution 생성

CloudFront 콘솔 → Create distribution

### Origin 1: S3 (Frontend)

**Origin domain**
- 드롭다운에서 S3 버킷 선택
- `guestbook-frontend-hojun121.s3.ap-northeast-2.amazonaws.com`

**Origin access**
- **Origin access control settings (recommended)** 선택
- Create new OAC
  - Name: `guestbook-frontend-oac`
  - 기본값 사용
- Create

⚠️ "S3 bucket policy needs updating" 알림 표시 → 나중에 처리

### Default cache behavior

- Viewer protocol policy: **Redirect HTTP to HTTPS**
- Allowed HTTP methods: **GET, HEAD**
- Cache policy: **CachingOptimized**

### Settings

- Price class: **Use only North America and Europe** (실습 비용 절감)
  - 또는 "Use all edge locations" (권장)
- Alternate domain name (CNAME): (공란, 커스텀 도메인 없으면)
- Default root object: `index.html`

Create distribution.

배포까지 약 5~15분 소요.

## Step 3. S3 버킷 정책 업데이트 (OAC 적용)

CloudFront가 알려주는 버킷 정책 복사 → S3 버킷 정책에 붙여넣기.

Distribution 상세 → Origins 탭 → S3 origin 선택 → Edit → 하단에 "Copy policy" 버튼

또는 수동:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontServicePrincipal",
      "Effect": "Allow",
      "Principal": {
        "Service": "cloudfront.amazonaws.com"
      },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::guestbook-frontend-hojun121/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::123456789012:distribution/EXXXXXXXXXXX"
        }
      }
    }
  ]
}
```

## Step 4. S3 퍼블릭 액세스 차단 복원

실습 5에서 열어둔 거 원복:

Permissions → Block public access → **Edit**
- "Block all public access" **다시 체크**
- 저장

Permissions → Bucket policy → 기존 퍼블릭 읽기 정책 삭제, OAC 정책만 유지

이제 S3는 CloudFront 통해서만 접근 가능.

## Step 5. Origin 2 추가: ALB (Backend API)

Distribution 상세 → Origins 탭 → Create origin

**Origin domain**
- ALB DNS 입력: `guestbook-alb-xxxxx.ap-northeast-2.elb.amazonaws.com`

**Protocol**
- **HTTP only** (ALB가 HTTP만 열려있음)
- Port: 80

**Name**
- `alb-origin`

Create origin.

## Step 6. Behavior 추가: /api/* → ALB

Distribution 상세 → Behaviors 탭 → Create behavior

**Settings**
- Path pattern: `/api/*`
- Origin: `alb-origin`

**Cache behavior**
- Viewer protocol policy: **Redirect HTTP to HTTPS**
- Allowed HTTP methods: **GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE** ⭐ (API이므로)

**Cache key and origin requests**
- Cache policy: **CachingDisabled** ⭐ (API는 캐싱 안 함)
- Origin request policy: **AllViewer**

Create behavior.

## Step 7. Behavior 우선순위 확인

Distribution → Behaviors 탭에서 순서 확인:

| Precedence | Path pattern | Origin |
|---|---|---|
| 0 | `/api/*` | alb-origin |
| 1 | Default (*) | S3 |

`/api/*`가 위에 있어야 함. 아니면 Move up.

## Step 8. 배포 완료 대기

Distribution 상태가 `Deploying` → `Enabled`로 변경 대기 (5~15분).

## Step 9. 접속 테스트

Distribution의 **Distribution domain name** 복사:
```
https://dxxxxxxxxxxxxx.cloudfront.net
```

브라우저로 접속:

### 확인 사항

1. **HTTPS로 자동 리다이렉트**
   - `http://dxxx.cloudfront.net` 입력 → HTTPS로 변경됨

2. **Frontend 정상 로드**
   - 방명록 화면 표시

3. **API 호출 동작**
   - `/api/messages` 호출 성공
   - 메시지 작성/조회/삭제 정상

4. **로드밸런싱 확인**
   - 새로고침 시 서버 ID 변경

5. **S3 직접 접근 차단**
   - `https://guestbook-frontend-hojun121.s3.ap-northeast-2.amazonaws.com/index.html`
   - 403 Forbidden 확인 → OAC 동작

### curl 테스트

```bash
# HTTPS로 API 호출
curl https://dxxx.cloudfront.net/api/health

# Frontend
curl https://dxxx.cloudfront.net/

# 여러 번 호출해서 로드밸런싱 확인
for i in {1..10}; do
  curl -s https://dxxx.cloudfront.net/api/health | grep -o '"server":"[^"]*"'
done
```

## Step 10. Invalidation (캐시 무효화)

Frontend 파일 수정 후 바로 반영 안 될 때:

Distribution → Invalidations 탭 → Create invalidation

- Object paths: `/*` (또는 특정 파일 `/index.html`)

월 1,000건까지 무료.

## 체크리스트

- [ ] CloudFront Distribution 생성
- [ ] OAC로 S3 보호
- [ ] S3 Block Public Access 복원
- [ ] Origin 2개: S3 + ALB
- [ ] Behavior: `/api/*` → ALB (캐싱 비활성)
- [ ] Behavior: Default → S3 (캐싱 활성)
- [ ] HTTPS 자동 리다이렉트
- [ ] CloudFront URL로 전체 기능 동작
- [ ] S3 직접 접근 403 확인

## 트러블슈팅

**403 에러 (CloudFront에서)**
- OAC 설정 확인
- S3 버킷 정책에 CloudFront Service Principal 있는지
- SourceArn이 맞는 Distribution ARN인지

**CORS 에러**
- CloudFront에서 같은 도메인으로 API 호출 → CORS 불필요
- 만약 에러나면 Backend의 `cors()` 확인

**API 호출이 403 또는 405**
- `/api/*` Behavior의 Allowed HTTP methods 확인
- POST/DELETE 허용했는지

**수정이 반영 안 됨**
- CloudFront 캐시 때문
- Invalidation `/*` 실행
- 또는 캐시 만료 대기

**배포가 오래 걸림**
- 정상. 10~20분 소요됨
- 그동안 기다리거나 다른 작업

**HTTPS 인증서 없다고 나옴**
- CloudFront 기본 도메인(`*.cloudfront.net`)은 AWS가 자동 제공
- 커스텀 도메인 쓸 때만 ACM 필요

## 최종 아키텍처 확인

```
사용자 (HTTPS)
  ↓
CloudFront (dxxx.cloudfront.net)
  ↓
  ├─ Default (*) ─→ S3 (Frontend, OAC 보호)
  │
  └─ /api/* ──→ ALB (pub-elb)
                 ↓
                Backend EC2 × 2 (pri-svc)
                 ↓
                RDS MySQL (pri-db)
```

축하합니다! 완전한 3-Tier 웹 아키텍처가 완성되었습니다.

## 다음 단계 (선택)

- Route 53으로 커스텀 도메인 연결
- ACM으로 HTTPS 인증서 발급
- WAF 연동
- Auto Scaling 적용
- CI/CD 파이프라인 구축

## 비용 정리 주의 ⚠️

실습 끝나면 **반드시 전체 리소스 삭제**:

**삭제 순서** (역순):
1. CloudFront Distribution (Disable → Delete)
2. S3 버킷 (비우고 삭제)
3. ALB
4. Target Group
5. RDS (스냅샷 없이)
6. EC2 인스턴스 (모두)
7. NAT Gateway
8. Elastic IP (해제)
9. VPC Endpoints
10. VPC (마지막)
