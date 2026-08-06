#!/bin/bash
set -e
dnf install -y nodejs20 git 2>/dev/null || (curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && dnf install -y nodejs)
npm install -g pm2
mkdir -p /opt/es-threads-temporal
touch /opt/es-threads-temporal/READY
