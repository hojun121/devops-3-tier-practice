# 실습 1. Bastion 구축 (pub-svc)

## 목표

- pub-svc 서브넷에 Bastion EC2 생성
- 내 PC → Bastion SSH 접속 확인
- Bastion을 통해 프라이빗 EC2 접속 준비

## 사전 조건

- VPC, 서브넷, IGW, 라우팅 테이블 완료
- pub-svc-a 서브넷 존재 (192.168.30.0/27)

## Step 1. 키 페어 생성

EC2 콘솔 → 키 페어 → 키 페어 생성

- 이름: `bastion-key`
- 키 파일 형식: `.pem` (Mac/Linux) 또는 `.ppk` (Windows PuTTY)
- `bastion-key.pem` 파일 다운로드 (한 번만 가능!)

다운로드 후 권한 설정:

```bash
chmod 400 ~/Downloads/bastion-key.pem
```

## Step 2. Bastion Security Group 생성

이름: `bastion-sg`
VPC: 실습 VPC

**인바운드 규칙**

| 타입 | 프로토콜 | 포트 | 소스 | 설명 |
|---|---|---|---|---|
| SSH | TCP | 22 | 내 IP (`x.x.x.x/32`) | 내 PC에서만 접속 |

⚠️ 절대 `0.0.0.0/0`으로 열지 말 것!

**아웃바운드**
기본값 유지 (모두 허용)

## Step 3. Bastion EC2 생성

EC2 콘솔 → 인스턴스 시작

**기본 정보**
- 이름: `bastion`
- AMI: Ubuntu Server 22.04 LTS
- 인스턴스 유형: `t3.micro` (프리 티어)
- 키 페어: `bastion-key`

**네트워크 설정**
- VPC: 실습 VPC
- 서브넷: `pub-svc-a`
- 퍼블릭 IP 자동 할당: **활성화**
- Security Group: `bastion-sg` (기존 선택)

**스토리지**
- 8 GiB gp3 (기본)

인스턴스 시작.

## Step 4. 접속 테스트

인스턴스 상세에서 퍼블릭 IPv4 주소 확인

```bash
ssh -i ~/Downloads/bastion-key.pem ubuntu@<퍼블릭IP>
```

처음 접속 시 "Are you sure you want to continue connecting?" → `yes`

접속 성공 시:
```
ubuntu@ip-192-168-30-X:~$
```

## Step 5. Bastion에 프라이빗 키 복사

프라이빗 EC2 접속용 키가 필요합니다.

**방법 1. SCP로 키 복사 (간단)**

로컬 PC에서:

```bash
scp -i ~/Downloads/bastion-key.pem \
    ~/Downloads/backend-key.pem \
    ubuntu@<Bastion_IP>:~/
```

(`backend-key.pem`은 다음 실습에서 만듭니다)

**방법 2. SSH Agent Forwarding (권장)**

로컬에서:

```bash
ssh-add ~/Downloads/backend-key.pem
ssh -A -i ~/Downloads/bastion-key.pem ubuntu@<Bastion_IP>
```

Bastion에서 바로 프라이빗 EC2로:

```bash
ssh ubuntu@<프라이빗IP>
```

## 체크리스트

- [ ] `bastion-key.pem` 다운로드 및 권한 400 설정
- [ ] Bastion SG는 내 IP의 22번 포트만 허용
- [ ] Bastion EC2가 `pub-svc-a` 서브넷에 배치됨
- [ ] 퍼블릭 IP로 SSH 접속 성공
- [ ] (선택) SSH Agent Forwarding 설정

## 트러블슈팅

**접속이 안 될 때**

1. **Security Group 확인**: 내 IP가 맞는지? (IP 바뀌었을 수 있음)
2. **라우팅 테이블**: pub-svc-a가 퍼블릭 RT에 연결됐는지?
3. **퍼블릭 IP**: 인스턴스에 퍼블릭 IP가 할당됐는지?
4. **키 권한**: `chmod 400 ~/Downloads/bastion-key.pem`
5. **사용자명**: Ubuntu AMI는 `ubuntu`, Amazon Linux는 `ec2-user`

**내 IP 확인 방법**

```bash
curl ifconfig.me
```
