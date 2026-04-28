#!/bin/bash

# ========================================
# Backend EC2 초기 설정 스크립트
# Ubuntu 22.04 기준
# ========================================

set -e

echo "=== System update ==="
sudo apt update
sudo apt upgrade -y

echo "=== Install Node.js 20 ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

echo "=== Install MySQL client (for testing) ==="
sudo apt install -y mysql-client

echo "=== Install PM2 (process manager) ==="
sudo npm install -g pm2

echo "=== Install Dependencies ==="
npm install

echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "1. Create .env file: cp .env.example .env"
echo "2. Edit .env with RDS credentials"
echo "3. Start server: pm2 start server.js --name backend"
echo "4. Check status: pm2 status"
echo "5. View logs: pm2 logs backend"
echo "6. Enable startup: pm2 startup && pm2 save"
