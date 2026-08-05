#!/bin/bash
set -e
cd /root/joblink-v2
echo "$(date) — Deploy started (webhook)"
git fetch origin master
git reset --hard origin/master
npm ci --omit=dev
pm2 restart joblink-v2
sleep 3
curl -sf http://localhost:3849/health || { echo "HEALTH CHECK FAILED"; exit 1; }
echo "$(date) — Deploy complete"
