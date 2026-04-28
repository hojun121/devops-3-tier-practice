#!/bin/bash
set -e
cd /home/ubuntu/backend

# 이미 떠있으면 reload, 아니면 start
if pm2 describe backend >/dev/null 2>&1; then
  pm2 reload backend --update-env
else
  pm2 start server.js --name backend
fi
pm2 save
