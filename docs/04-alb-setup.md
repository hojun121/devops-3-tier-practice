# 실습 4. ALB 구축 및 연결 (pub-elb)

## 목표

- pub-elb 서브넷에 외부 ALB 생성
- Backend EC2 2대를 Target Group에 등록
- 헬스체크 확인
- ALB DNS로 외부 접속 테스트

## Step 1. ALB Security Group 생성

이름: `alb-sg`
VPC: 실습 VPC

**인바운드**

| 타입 | 포트 | 소스 | 설명 |
|---|---|---|---|
| HTTP | 80 | `0.0.0.0/0` | 전 세계 허용 (실습) |
| HTTPS | 443 | `0.0.0.0/0` | (HTTPS는 나중에) |

**아웃바운드**: 기본값

## Step 2. Backend SG에 ALB 접근 허용

EC2 콘솔 → Security Groups → `backend-sg` 편집

**인바운드 규칙 추가**

| 타입 | 포트 | 소스 |
|---|---|---|
| Custom TCP | 8080 | `alb-sg` |

## Step 3. Target Group 생성

EC2 콘솔 → Target Groups → Create target group

**Basic configuration**
- Target type: **Instances**
- 이름: `backend-tg`
- Protocol: HTTP
- Port: `8080`
- VPC: 실습 VPC
- Protocol version: HTTP1

**Health checks**
- Protocol: HTTP
- Path: `/api/health`

**Advanced health check**
- Port: traffic port (8080)
- Healthy threshold: 2
- Unhealthy threshold: 3
- Timeout: 5s
- Interval: 30s
- Success codes: 200

Next → **Register targets**

**Targets 등록**
- `backend-a`, `backend-c` 선택
- Port: 8080
- "Include as pending below" 클릭
- Create target group

## Step 4. ALB 생성

EC2 콘솔 → Load Balancers → Create Load Balancer → **Application Load Balancer**

**Basic configuration**
- 이름: `guestbook-alb`
- Scheme: **Internet-facing**
- IP address type: IPv4

**Network mapping**
- VPC: 실습 VPC
- Mappings:
  - `ap-northeast-2a`: `pub-elb-a` 선택
  - `ap-northeast-2c`: `pub-elb-c` 선택

**Security groups**
- `alb-sg` 선택 (기본 SG는 제거)

**Listeners and routing**
- Protocol: HTTP
- Port: 80
- Default action: Forward to `backend-tg`

Create load balancer.

생성까지 약 2~3분 소요.

## Step 5. ALB DNS 확인

ALB 상세 → **DNS name** 복사

예시:
```
guestbook-alb-123456789.ap-northeast-2.elb.amazonaws.com
```

## Step 6. 타겟 상태 확인

EC2 콘솔 → Target Groups → `backend-tg` → Targets 탭

두 EC2 상태가 **healthy**가 되는 것을 확인:

```
backend-a  i-xxxxx  8080  ap-northeast-2a  healthy
backend-c  i-yyyyy  8080  ap-northeast-2c  healthy
```

처음엔 `initial` 상태였다가 헬스체크 통과하면 `healthy`로 바뀜.

## Step 7. 외부 접속 테스트

### 브라우저 또는 curl

```bash
# 헬스체크
curl http://<ALB_DNS>/api/health

# 여러 번 실행해서 서버 ID 다른지 확인
for i in {1..10}; do
  curl -s http://<ALB_DNS>/api/health | grep -o '"server":"[^"]*"'
done
```

예상 결과 (로드밸런싱 확인):
```
"server":"ip-192-168-50-12"
"server":"ip-192-168-51-24"
"server":"ip-192-168-50-12"
"server":"ip-192-168-51-24"
...
```

두 서버 ID가 번갈아 나와야 정상.

### 메시지 API 테스트

```bash
# 목록 조회
curl http://<ALB_DNS>/api/messages

# 메시지 작성
curl -X POST http://<ALB_DNS>/api/messages \
  -H "Content-Type: application/json" \
  -d '{"name":"ALB테스트","content":"로드밸런서 통해 작성"}'

# 재조회
curl http://<ALB_DNS>/api/messages
```

## Step 8. 장애 시뮬레이션 (선택)

EC2 콘솔에서 `backend-a`를 **Stop**

Target Group에서 `backend-a`가 `unhealthy`로 바뀌는 것 확인

이제 모든 요청이 `backend-c`로:

```bash
for i in {1..10}; do
  curl -s http://<ALB_DNS>/api/health | grep -o '"server":"[^"]*"'
done
```

모두 같은 서버 ID가 나옴 → 장애 대응 성공

실습 후 `backend-a` 다시 Start.

## 체크리스트

- [ ] ALB가 pub-elb-a, pub-elb-c 두 AZ에 걸쳐 배포
- [ ] ALB SG 인바운드: 80 (0.0.0.0/0)
- [ ] backend-sg에 alb-sg의 8080 허용 추가
- [ ] Target Group 헬스체크 `/api/health`, 포트 8080
- [ ] 두 EC2 모두 `healthy` 상태
- [ ] ALB DNS로 외부 접속 성공
- [ ] 여러 번 호출 시 서버 ID가 번갈아 나옴
- [ ] API 작성/조회 정상 동작

## 트러블슈팅

**타겟이 `unhealthy`**

원인별 해결:

1. **SG 문제**
   - backend-sg의 8080에 alb-sg Source 있는지
   - alb-sg에서 아웃바운드 허용되는지

2. **앱이 안 뜸**
   - EC2에서 `curl localhost:8080/api/health` 확인
   - `pm2 status`로 앱 상태 확인
   - `pm2 logs backend`로 에러 확인

3. **헬스체크 경로 불일치**
   - Target Group의 Path가 `/api/health` 맞는지
   - 200 응답이 오는지

4. **포트 불일치**
   - Target Group Port: 8080
   - EC2 앱 포트: 8080

**502 Bad Gateway**
- 타겟이 unhealthy일 때
- 앱이 죽었을 때
- 위 "unhealthy" 항목 참조

**504 Gateway Timeout**
- 앱 응답이 너무 느림
- DB 연결 문제 가능성

**시간 지나도 initial**
- 헬스체크 통과 대기 (최대 1분)
- 계속 initial이면 SG 확인

## ALB 요금 주의 ⚠️

- ALB는 **생성 즉시 시간당 과금**
- 데이터 처리 요금도 있음
- 실습 끝나면 **반드시 삭제**
