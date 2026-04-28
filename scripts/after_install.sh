#!/bin/bash
set -e
cd /home/ubuntu/backend

# .env는 Launch Template userdata가 미리 만들어둠.
# 없으면 LT 설정 누락 — 배포 중단.
if [ ! -f .env ]; then
  echo "ERROR: /home/ubuntu/backend/.env not found."
  echo "Check Launch Template userdata."
  exit 1
fi

# 프로덕션 의존성만 설치
npm ci --omit=dev --no-audit --no-fund
