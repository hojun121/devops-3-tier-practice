#!/bin/bash
# B/G 배포에선 새 인스턴스에 PM2가 아직 없을 수 있음. 실패해도 무시.
if command -v pm2 >/dev/null 2>&1; then
  pm2 delete backend || true
fi
exit 0
