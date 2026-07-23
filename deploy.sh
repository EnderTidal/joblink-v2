#!/usr/bin/env bash
# JobLink V2 — Deploy script with test gate + smoke verification
set -euo pipefail

cd "$(dirname "$0")"
NODE=/opt/node22/bin/node

echo "=== JobLink V2 Deploy ==="
echo "$(date '+%Y-%m-%d %H:%M:%S') — Starting deploy"

# Step 1: Run E2E tests
echo ""
echo "--- Running E2E test suite ---"
if ! $NODE tests/e2e-full.js; then
  echo ""
  echo "DEPLOY ABORTED — tests failed"
  exit 1
fi

# Step 2: Restart PM2
echo ""
echo "--- Restarting PM2 process ---"
pm2 restart joblink-v2

# Step 3: Wait for process to be ready
echo "Waiting 3 seconds for startup..."
sleep 3

# Step 4: Run original smoke test
echo ""
echo "--- Running post-deploy smoke test (legacy) ---"
if ! $NODE scripts/smoke.js; then
  echo ""
  echo "WARNING: Legacy smoke test FAILED after deploy!"
  echo "Server is running but may have issues."
  $NODE scripts/send-alert.js "SMOKE TEST FAILED after deploy" "Legacy smoke test failed after pm2 restart. Server is running but may have issues. Check logs: pm2 logs joblink-v2" 2>/dev/null || true
  exit 1
fi

# Step 5: Run E2E HTTP smoke test
echo ""
echo "--- Running E2E HTTP smoke test ---"
if ! $NODE scripts/e2e-smoke.js; then
  echo ""
  echo "WARNING: E2E smoke test FAILED after deploy!"
  $NODE scripts/send-alert.js "E2E SMOKE FAILED after deploy" "E2E HTTP smoke test failed after pm2 restart. Check routes. Logs: pm2 logs joblink-v2" 2>/dev/null || true
  exit 1
fi

echo ""
echo "=== Deploy complete ==="
echo "$(date '+%Y-%m-%d %H:%M:%S') — All tests passed, server is live"
