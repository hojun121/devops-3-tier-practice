#!/bin/bash
set -e
# 헬스체크: 30초 동안 5회 시도 (앱 부팅 대기)
for i in {1..5}; do
  if curl -fsS http://localhost:8080/api/health >/dev/null; then
    echo "Health check passed"
    exit 0
  fi
  echo "Health check attempt $i/5 failed, retrying in 6s..."
  sleep 6
done

echo "Health check failed after 5 attempts"
exit 1
