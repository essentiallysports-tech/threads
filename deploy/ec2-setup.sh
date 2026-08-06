#!/bin/bash
# Run this ONCE on a fresh EC2 instance (Amazon Linux 2023 or Ubuntu 22.04+)
# to set it up as the Temporal worker host. Not automated end-to-end (no
# Terraform/CDK yet) — see README "Known gaps" for why, and what to build
# once the AWS permissions are broadened.
set -e

# 1. Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - 2>/dev/null || \
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs 2>/dev/null || sudo apt-get install -y nodejs

# 2. pm2 — process supervisor, restarts the worker on crash/reboot
sudo npm install -g pm2
pm2 startup

# 3. Clone/pull the repo (replace with real remote once this is pushed somewhere)
# git clone <repo-url> es-threads-temporal
cd es-threads-temporal
npm install
npm run build

# 4. Put real secrets in /etc/es-threads-temporal.env (root-only readable),
#    NEVER committed to git — see .env.local.example for the required keys.
sudo touch /etc/es-threads-temporal.env
sudo chmod 600 /etc/es-threads-temporal.env
echo "Now edit /etc/es-threads-temporal.env with real values, then run:"
echo "  pm2 start dist/worker.js --name es-threads-worker --env-file /etc/es-threads-temporal.env"
echo "  pm2 save"
