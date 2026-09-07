#!/usr/bin/env bash
# JobLink V2 — Deploy script with staging confirmation gate + test gate + TOTP gate + smoke verification
set -euo pipefail

cd "$(dirname "$0")"
NODE=/opt/node22/bin/node

echo "=== JobLink V2 Deploy ==="
echo "$(date '+%Y-%m-%d %H:%M:%S') — Starting deploy"

# ──────────────────────────────────────────────
# STAGING CONFIRMATION GATE (added Sep 6, 2026)
# ──────────────────────────────────────────────

# Allow --force flag to skip interactive prompt (for CI/CD only)
FORCE=false
for arg in "$@"; do
  if [ "$arg" = "--force" ]; then
    FORCE=true
  fi
done

# Step 0a: Verify staging is running and healthy
echo ""
echo "--- Checking staging health ---"
STAGING_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3848/health 2>/dev/null || echo "000")
if [ "$STAGING_HEALTH" != "200" ]; then
  echo ""
  echo "DEPLOY BLOCKED — Staging server (joblink-v2-staging) is NOT healthy."
  echo "  HTTP status: $STAGING_HEALTH"
  echo "  You must deploy and verify on staging FIRST before touching prod."
  echo "  Run: cd /root/joblink-v2-staging && git pull && npm ci --omit=dev && pm2 restart joblink-v2-staging"
  echo ""
  exit 1
fi
echo "Staging health: OK (HTTP 200)"

# Step 0b: Check that staging is running the same (or newer) code as what we are about to deploy
STAGING_DIR="/root/joblink-v2-staging"
if [ -d "$STAGING_DIR/.git" ]; then
  PROD_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
  STAGING_HEAD=$(git -C "$STAGING_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")
  echo "Prod HEAD:    $PROD_HEAD"
  echo "Staging HEAD: $STAGING_HEAD"
  if [ "$PROD_HEAD" != "unknown" ] && [ "$STAGING_HEAD" != "unknown" ]; then
    # Check if staging has the prod commit in its history (staging should be at or ahead of prod)
    if ! git -C "$STAGING_DIR" merge-base --is-ancestor "$PROD_HEAD" "$STAGING_HEAD" 2>/dev/null; then
      echo ""
      echo "WARNING: Staging does not appear to contain the current prod commit."
      echo "  This means staging may be behind prod or on a different branch."
    fi
  fi
fi

# Step 0c: Interactive confirmation (skipped with --force for CI)
if [ "$FORCE" = false ]; then
  echo ""
  echo "┌──────────────────────────────────────────────────────┐"
  echo "│  PRODUCTION DEPLOY CONFIRMATION                      │"
  echo "│                                                      │"
  echo "│  Before proceeding, confirm:                         │"
  echo "│  1. Changes were tested on staging                   │"
  echo "│  2. Staging health check passed (verified above)     │"
  echo "│  3. You visually verified staging in the browser     │"
  echo "└──────────────────────────────────────────────────────┘"
  echo ""
  read -p "Have you tested and verified these changes on staging? (yes/no): " CONFIRM
  if [ "$CONFIRM" != "yes" ]; then
    echo ""
    echo "DEPLOY ABORTED — Go test on staging first."
    echo "  Staging URL: https://staging.joblinkplatform.com"
    exit 1
  fi
  echo ""
  echo "Confirmation received. Proceeding with TOTP verification..."
fi

# ──────────────────────────────────────────────
# TOTP VERIFICATION GATE (added Sep 7, 2026)
# ──────────────────────────────────────────────
if [ "$FORCE" != "true" ]; then
  TOTP_SECRET=$(cat /root/.deploy-totp-secret 2>/dev/null)
  if [ -z "$TOTP_SECRET" ]; then
    echo "ERROR: TOTP secret not configured. Run setup first."
    exit 1
  fi

  echo ""
  read -p "Enter 6-digit authenticator code: " TOTP_CODE

  EXPECTED=$(oathtool --totp -b "$TOTP_SECRET")
  if [ "$TOTP_CODE" != "$EXPECTED" ]; then
    echo "DEPLOY BLOCKED — Invalid authenticator code."
    exit 1
  fi
  echo "Authenticator code verified ✓"
fi

# ──────────────────────────────────────────────
# ORIGINAL DEPLOY STEPS
# ──────────────────────────────────────────────

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
