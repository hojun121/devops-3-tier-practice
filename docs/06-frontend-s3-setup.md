# 실습 5. Frontend S3 배포

## 목표

- S3 버킷에 Frontend 파일 업로드
- 정적 웹사이트 호스팅 활성화 (임시 테스트용)
- ALB와 연결해서 API 호출 확인

## Step 1. Frontend 코드 수정

`frontend/app.js` 상단의 `API_BASE` 수정:

**실습 단계에서는 ALB DNS를 직접 사용:**

```javascript
const API_BASE = 'http://<ALB_DNS>/api';
```

예:
```javascript
const API_BASE = 'http://guestbook-alb-1234.ap-northeast-2.elb.amazonaws.com/api';
```

⚠️ 다음 CloudFront 실습에서는 `/api`로 바꿀 예정.

## Step 2. S3 버킷 생성

S3 콘솔 → Create bucket

**일반 구성**
- 버킷 이름: `guestbook-frontend-<본인식별자>` (글로벌 유일!)
  - 예: `guestbook-frontend-hojun121`
- 리전: 아시아 태평양 (서울) ap-northeast-2

**객체 소유권**
- ACLs disabled (권장)

**퍼블릭 액세스 차단**
- 일단 모두 **체크 유지** (권장)
- CloudFront로 접근할 예정이므로

**나머지**
- 기본값 유지

버킷 생성.

## Step 3. Frontend 파일 업로드

S3 버킷 상세 → Upload → Add files

업로드할 파일:
- `index.html`
- `app.js`
- `style.css`

또는 AWS CLI:

```bash
aws s3 sync ./frontend/ s3://guestbook-frontend-hojun121/
```

## Step 4. (임시) 정적 웹사이트 호스팅 활성화

⚠️ 이건 **임시 테스트용**. 최종 배포에서는 CloudFront만 사용.

버킷 → Properties → Static website hosting → Edit

- Static website hosting: **Enable**
- Index document: `index.html`
- Error document: `index.html`

저장 후 **버킷 웹사이트 엔드포인트** 메모.

## Step 5. (임시) 퍼블릭 액세스 활성화

⚠️ 다음 실습에서 CloudFront로 전환 후 되돌릴 예정.

### Block public access 해제

Permissions → Block public access (bucket settings) → Edit
- "Block all public access" **해제**
- 경고 확인 후 저장

### 버킷 정책 추가

Permissions → Bucket policy → Edit

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::guestbook-frontend-hojun121/*"
    }
  ]
}
```

(버킷 이름을 본인 것으로 변경)

## Step 6. 접속 테스트

S3 웹사이트 엔드포인트로 브라우저 접속:

```
http://guestbook-frontend-hojun121.s3-website.ap-northeast-2.amazonaws.com
```

**예상 동작**
- 방명록 화면이 뜸
- 상단에 "응답한 서버: ip-xxx" 표시
- 메시지 작성/조회/삭제 가능
- 5초마다 자동 새로고침

## Step 7. CORS 이슈 확인

⚠️ **중요**: S3(HTTP) → ALB(HTTP) 호출 시 CORS 이슈 없음.
단, 혼합 콘텐츠나 도메인 다름 주의.

Backend 코드에 `cors()` 미들웨어가 이미 포함되어 있어 모든 Origin 허용.

실무에선 특정 도메인만 허용해야 함:
```javascript
app.use(cors({
  origin: 'https://www.example.com'
}));
```

## 체크리스트

- [ ] S3 버킷 이름이 글로벌 유일
- [ ] index.html, app.js, style.css 업로드
- [ ] app.js의 API_BASE가 ALB DNS로 설정
- [ ] (임시) 정적 웹사이트 호스팅 활성화
- [ ] (임시) 버킷 정책으로 퍼블릭 읽기 허용
- [ ] 브라우저에서 방명록 화면 정상 표시
- [ ] 메시지 작성 → DB에 저장 → 목록에 표시
- [ ] 서버 ID가 번갈아 나타남 (로드밸런싱 확인)

## 트러블슈팅

**403 Forbidden**
- Block public access 해제 확인
- 버킷 정책 적용 확인
- 객체에 퍼블릭 읽기 권한 있는지

**CORS 에러 (브라우저 콘솔)**
```
Access to fetch at '...' has been blocked by CORS policy
```
- Backend의 `cors()` 미들웨어 확인
- `npm install cors` 설치 확인
- PM2 재시작: `pm2 restart backend`

**"응답한 서버: 연결 실패"**
- ALB DNS 주소 정확한지
- ALB가 동작 중인지
- Target Group 상태 healthy인지

**Mixed Content 경고**
- S3 웹사이트는 HTTP만 지원
- ALB도 HTTP라서 OK
- HTTPS 쓸 거면 CloudFront로 (다음 실습)

## 다음 단계

임시 설정으로 동작은 되지만, 프로덕션에는 부적합:
- HTTPS 지원 안 함
- 글로벌 캐싱 없음
- S3 직접 노출

다음 실습에서 **CloudFront**로 해결.
