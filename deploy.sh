#!/usr/bin/env bash
# JobLink V2 — Deploy script
# Gate order: staging health → code parity → confirmation → pre-deploy checks → E2E tests → changelog collect → email preview → docs reminder → TOTP LAUNCH → PM2 restart → smoke test → changelog write → Grok verify → summary
set -euo pipefail

cd "$(dirname "$0")"
NODE=/usr/bin/node

echo "=== JobLink V2 Deploy ==="
echo "$(date '+%Y-%m-%d %H:%M:%S') — Starting deploy"

# Allow --force flag to skip interactive gates (for CI/CD only)
FORCE=false
for arg in "$@"; do
  if [ "$arg" = "--force" ]; then
    FORCE=true
  fi
done

# ──────────────────────────────────────────────
# PRE-TOTP — all prep, can block
# ──────────────────────────────────────────────

# Step 1: Staging health check
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

# Step 2: Code parity check
STAGING_DIR="/root/joblink-v2-staging"
if [ -d "$STAGING_DIR/.git" ]; then
  PROD_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
  STAGING_HEAD=$(git -C "$STAGING_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")
  echo "Prod HEAD:    $PROD_HEAD"
  echo "Staging HEAD: $STAGING_HEAD"
  if [ "$PROD_HEAD" != "unknown" ] && [ "$STAGING_HEAD" != "unknown" ]; then
    if ! git -C "$STAGING_DIR" merge-base --is-ancestor "$PROD_HEAD" "$STAGING_HEAD" 2>/dev/null; then
      echo ""
      echo "WARNING: Staging does not appear to contain the current prod commit."
      echo "  This means staging may be behind prod or on a different branch."
    fi
  fi
fi

# Step 3: Staging confirmation (interactive or arg $2)
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
  echo "Confirmation received. Running pre-deploy checks..."
fi

# Step 4: Pre-deploy checks
echo ""
echo "--- Running pre-deploy checklist ---"
if ! $NODE scripts/pre-deploy-checks.js; then
  echo ""
  echo "DEPLOY BLOCKED — pre-deploy checks failed. Fix issues above before deploying."
  exit 1
fi

# Step 5: E2E test suite
echo ""
echo "--- Running E2E test suite ---"
if ! $NODE --test-force-exit tests/e2e-full.js; then
  echo ""
  echo "DEPLOY ABORTED — tests failed"
  exit 1
fi

# Step 6: Collect changelog entry (stored in variables — NOT written to DB yet)
CL_VERSION=""
CL_TITLE=""
CL_BODY=""
if [ "$FORCE" = false ]; then
  echo ""
  echo "--- Changelog Entry (collected now, written after deploy) ---"
  read -p "Changelog version (e.g. 2.9.0): " CL_VERSION
  read -p "Changelog title: " CL_TITLE

  if [ -n "$CL_VERSION" ] && [ -n "$CL_TITLE" ]; then
    echo "Enter changelog body (end with EOF on a new line):"
    while IFS= read -r line; do
      [[ "$line" == "EOF" ]] && break
      CL_BODY="${CL_BODY}${line}\n"
    done
  else
    echo "WARNING: Version or title was empty — changelog will be skipped."
  fi
fi

# Step 7: Email preview (send before TOTP so you can review while deploying)
if [ -n "$CL_VERSION" ] && [ -n "$CL_TITLE" ]; then
  echo ""
  echo "--- Sending changelog preview email ---"
  $NODE -e "
const https = require('https');
const version = process.argv[1], title = process.argv[2], body = process.argv[3];
const html = '<div style=\"font-family:-apple-system,sans-serif;max-width:620px;margin:0 auto\">'
  + '<div style=\"background:#4338ca;color:#fff;padding:24px 32px;border-radius:12px 12px 0 0\">'
  + '<h1 style=\"margin:0;font-size:22px\">What\'s New in JobLink</h1>'
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
  echo "Check joshuafriends@gmail.com for the preview."
fi

# Step 8: Docs/shape reminder
echo ""
echo "========================================"
echo "  PRE-DEPLOY REMINDER"
echo "========================================"
echo "  1. Update shape file if architecture changed"
echo "  2. Update docs (docs site) if new features were added"
echo "========================================"

# ──────────────────────────────────────────────
# TOTP GATE — the launch button
# ──────────────────────────────────────────────
if [ "$FORCE" != "true" ]; then
  TOTP_SECRET=$(cat /root/.deploy-totp-secret 2>/dev/null)
  if [ -z "$TOTP_SECRET" ]; then
    echo "ERROR: TOTP secret not configured. Run setup first."
    exit 1
  fi

  echo ""
  echo "┌──────────────────────────────────────────────────────┐"
  echo "│  TOTP GATE — LAUNCH BUTTON                           │"
  echo "│  All checks passed. Enter your code to deploy.       │"
  echo "└──────────────────────────────────────────────────────┘"
  TOTP_CODE="${3:-}"; if [ -z "$TOTP_CODE" ]; then read -p "Enter 6-digit authenticator code: " TOTP_CODE; fi

  EXPECTED=$(oathtool --totp -b "$TOTP_SECRET")
  if [ "$TOTP_CODE" != "$EXPECTED" ]; then
    echo "DEPLOY BLOCKED — Invalid authenticator code."
    exit 1
  fi
  echo "Authenticator code verified ✓"
fi

# ──────────────────────────────────────────────
# POST-TOTP — fully automated, no interactive prompts, no stops
# ──────────────────────────────────────────────

# Step 9: PM2 restart
echo ""
echo "--- Restarting PM2 process ---"
touch /tmp/.joblink-deploy-active
pm2 restart joblink-v2

# Step 10: Wait 3s + smoke test
echo "Waiting 3 seconds for startup..."
sleep 3
echo ""
echo "--- Running post-deploy smoke test ---"
if ! $NODE tests/smoke-prod.js; then
  echo ""
  echo "WARNING: Smoke test FAILED after deploy!"
  echo "Server is running but may have issues."
  $NODE scripts/send-alert.js "SMOKE TEST FAILED after deploy" "smoke-prod.js failed after pm2 restart. Check logs: pm2 logs joblink-v2" 2>/dev/null || true
  exit 1
fi
rm -f /tmp/.joblink-deploy-active

# Step 11: Write changelog to all org DBs (using variables collected pre-TOTP)
if [ -n "$CL_VERSION" ] && [ -n "$CL_TITLE" ]; then
  echo ""
  echo "--- Writing changelog to all org DBs ---"
  $NODE -e "
const fs = require('fs');
const Database = require('better-sqlite3');
const dir = process.env.DATA_DIR || 'data';
const version = process.argv[1], title = process.argv[2], body = process.argv[3];
fs.readdirSync(dir).filter(f => /^org-\d+\.db\$/.test(f)).forEach(f => {
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

# Step 12: Grok post-deploy verify
echo ""
echo "--- Grok Post-Deploy Verify ---"
echo "Posting smoke test task to JobLink QA Grok..."

BRIDGE_KEY="${IRIS_BRIDGE_KEY:-1a2bbd50ff5d4c66748f110dfe08da9ecdc38047d37abf7f68dc429c2f83d084}"
BRIDGE_URL="https://bridge.thetelosway.com/joblink-qa"

curl -s -X POST "$BRIDGE_URL/tasks" \
  -H "Authorization: Bearer $BRIDGE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"iris\",\"to\":\"grok\",\"title\":\"VERIFY: Post-deploy smoke test on PROD — $1\",\"brief\":\"JobLink just deployed to production. Smoke test the following on app.joblinkplatform.com:\n\n1. Login page loads\n2. Wizard loads at /wizard.html\n3. Admin page loads at /admin.html\n4. All admin tabs visible (Settings, API Keys, Categories, Users, Templates, Messaging, Candidates, Feedback, Changelog, Reports, Team)\n5. Take SCREENSHOTS of any issues\n\nReport PASS/FAIL with evidence.\",\"priority\":\"urgent\"}"

echo ""
echo "Grok will verify on prod. Check bridge for results."

# Step 13: Final summary
echo ""
echo "========================================"
echo "  DEPLOY COMPLETE"
echo "========================================"
echo "$(date '+%Y-%m-%d %H:%M:%S') — All steps passed, server is live"
echo "  Commit:    $1"
echo "  Version:   ${CL_VERSION:-n/a}"
echo "  Changelog: ${CL_TITLE:-n/a}"
echo "========================================"
echo "  POST-DEPLOY:"
echo "  1. Approve the preview email and send to customers"
echo "  2. Check bridge for Grok QA results"
echo "========================================"
