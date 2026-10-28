#!/usr/bin/env bash
# JobLink V2 — Deploy script with staging confirmation gate + test gate + TOTP gate + smoke verification
set -euo pipefail

cd "$(dirname "$0")"
NODE=/usr/bin/node

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
STAGING_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3850/ 2>/dev/null || echo "000")
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
  CONFIRM="${2:-}"; if [ -z "$CONFIRM" ]; then read -p "Have you tested and verified these changes on staging? (yes/no): " CONFIRM; fi
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
  TOTP_CODE="${3:-}"; if [ -z "$TOTP_CODE" ]; then read -p "Enter 6-digit authenticator code: " TOTP_CODE; fi

  EXPECTED=$(oathtool --totp -b "$TOTP_SECRET")
  if [ "$TOTP_CODE" != "$EXPECTED" ]; then
    echo "DEPLOY BLOCKED — Invalid authenticator code."
    exit 1
  fi
  echo "Authenticator code verified ✓"
fi

# ──────────────────────────────────────────────
# PRE-DEPLOY CHECKLIST (automated — added by IRIS)
# ──────────────────────────────────────────────
echo ""
echo "--- Running pre-deploy checklist ---"
if ! $NODE scripts/pre-deploy-checks.js; then
  echo ""
  echo "DEPLOY BLOCKED — pre-deploy checks failed. Fix issues above before deploying."
  exit 1
fi

# ORIGINAL DEPLOY STEPS
# ──────────────────────────────────────────────

# Step 1: Run E2E tests
echo ""
echo "--- Running E2E test suite ---"
if ! $NODE --test-force-exit tests/e2e-full.js; then
  echo ""
  echo "DEPLOY ABORTED — tests failed"
  exit 1
fi

# Step 2: Restart PM2
echo ""
echo "--- Restarting PM2 process ---"
touch /tmp/.joblink-deploy-active
pm2 restart joblink-v2

# Step 3: Wait for process to be ready
echo "Waiting 3 seconds for startup..."
sleep 3

# Step 4: Run post-deploy smoke test (tests every critical endpoint)
echo ""
echo "--- Running post-deploy smoke test ---"
if ! $NODE tests/smoke-prod.js; then
  echo ""
  echo "WARNING: Smoke test FAILED after deploy!"
  echo "Server is running but may have issues."
  $NODE scripts/send-alert.js "SMOKE TEST FAILED after deploy" "smoke-prod.js failed after pm2 restart. Check logs: pm2 logs joblink-v2" 2>/dev/null || true
  exit 1
fi

echo ""
echo "=== Deploy complete ==="
echo "$(date '+%Y-%m-%d %H:%M:%S') — All tests passed, server is live"
# Clean up deploy lock
rm -f /tmp/.joblink-deploy-active

# ──────────────────────────────────────────────
# GATE 9: CHANGELOG ENTRY (added Oct 26, 2026)
# ──────────────────────────────────────────────
echo ""
echo "--- Changelog Entry ---"
read -p "Changelog version (e.g. 2.9.0): " CL_VERSION
read -p "Changelog title: " CL_TITLE

if [ -z "$CL_VERSION" ] || [ -z "$CL_TITLE" ]; then
  echo "WARNING: Skipping changelog — version or title was empty."
else
  echo "Enter changelog body (end with EOF on a new line):"
  CL_BODY=""
  while IFS= read -r line; do
    [[ "$line" == "EOF" ]] && break
    CL_BODY="${CL_BODY}${line}\n"
  done

  $NODE -e "
const fs = require('fs');
const Database = require('better-sqlite3');
const dir = process.env.DATA_DIR || 'data';
const version = process.argv[1], title = process.argv[2], body = process.argv[3];
fs.readdirSync(dir).filter(f => /^org-\d+\.db$/.test(f)).forEach(f => {
  try {
    const db = new Database(dir + '/' + f);
    db.prepare('INSERT INTO changelog_entries (version, title, body) VALUES (?, ?, ?)').run(version, title, body);
    db.close();
    console.log('  Added to ' + f);
  } catch(e) { console.log('  Skipped ' + f + ': ' + e.message); }
});
console.log('Changelog entry added to all orgs');
" "$CL_VERSION" "$CL_TITLE" "$CL_BODY"
fi

# ──────────────────────────────────────────────
# GATE 10: EMAIL PREVIEW (added Oct 26, 2026)
# ──────────────────────────────────────────────
if [ -n "${CL_VERSION:-}" ] && [ -n "${CL_TITLE:-}" ]; then
  echo ""
  echo "--- Sending changelog preview email ---"
  $NODE -e "
const https = require('https');
const version = process.argv[1], title = process.argv[2], body = process.argv[3];
const html = '<div style=\"font-family:-apple-system,sans-serif;max-width:620px;margin:0 auto\">'
  + '<div style=\"background:#4338ca;color:#fff;padding:24px 32px;border-radius:12px 12px 0 0\">'
  + '<h1 style=\"margin:0;font-size:22px\">What\\'s New in JobLink</h1>'
  + '<p style=\"margin:6px 0 0;opacity:0.85;font-size:14px\">' + version + '</p></div>'
  + '<div style=\"padding:24px 32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px\">'
  + '<h2 style=\"font-size:18px;color:#1e1b4b;margin:0 0 8px\">' + title + '</h2>'
  + '<p style=\"color:#374151;line-height:1.6\">' + body.replace(/\\\\n/g, '<br>') + '</p>'
  + '<div style=\"text-align:center;margin:24px 0\">'
  + '<a href=\"https://app.joblinkplatform.com\" style=\"display:inline-block;background:#4338ca;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600\">Try it now</a></div>'
  + '<hr style=\"border:none;border-top:1px solid #e5e7eb;margin:24px 0\"/>'
  + '<p style=\"color:#6b7280;font-size:13px\">Questions? Reply to this email.</p></div></div>';
const payload = JSON.stringify({
  from: 'The JobLink Team <notifications@joblinkplatform.com>',
  to: ['joshuafriends@gmail.com'],
  subject: '[PREVIEW] JobLink Update — ' + title,
  html
});
const req = https.request({
  hostname: 'api.resend.com', path: '/emails', method: 'POST',
  headers: { 'Authorization': 'Bearer ' + (process.env.RESEND_KEY || ''), 'Content-Type': 'application/json' }
}, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => console.log(res.statusCode === 200 ? 'Preview email sent!' : 'Email failed: ' + d));
});
req.write(payload);
req.end();
" "$CL_VERSION" "$CL_TITLE" "${CL_BODY:-}"
  echo ""
  echo "Check joshuafriends@gmail.com for the preview."
  echo "After approving, send to customers from Admin > Changelog > Send to Customers."
fi

# ──────────────────────────────────────────────
# GATE 11: DOCS REMINDER (added Oct 26, 2026)
# ──────────────────────────────────────────────
echo ""
echo "========================================"
echo "  DEPLOY COMPLETE — POST-DEPLOY TASKS"
echo "========================================"
echo "  1. Update shape file if architecture changed"
echo "  2. Approve the preview email and send to customers"
echo "  3. Update docs (docs site) if new features were added"
echo "========================================"
