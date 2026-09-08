#!/usr/bin/env bash
# PM2 Guard — prevents direct pm2 restart of joblink-v2 outside deploy.sh
# Install: alias pm2 to this script, or rename real pm2

LOCKFILE="/tmp/.joblink-deploy-active"
PROCESS_NAME="joblink-v2"

# Check if we're being called for joblink-v2 restart/reload
if [[ "$*" =~ (restart|reload|start).*$PROCESS_NAME ]] || [[ "$*" =~ $PROCESS_NAME.*(restart|reload|start) ]]; then
  # Check if deploy.sh set the lock
  if [ ! -f "$LOCKFILE" ]; then
    echo ""
    echo "╔══════════════════════════════════════════════════════╗"
    echo "║  BLOCKED — Direct pm2 restart of joblink-v2         ║"
    echo "║                                                      ║"
    echo "║  You MUST use deploy.sh to deploy to production.     ║"
    echo "║  Run: cd /root/joblink-v2 && bash deploy.sh          ║"
    echo "║                                                      ║"
    echo "║  deploy.sh runs tests, staging checks, and TOTP      ║"
    echo "║  before allowing a restart. Direct restarts are       ║"
    echo "║  blocked to prevent production incidents.             ║"
    echo "╚══════════════════════════════════════════════════════╝"
    echo ""
    echo "If this is an EMERGENCY and you need to force restart:"
    echo "  touch /tmp/.joblink-deploy-active && pm2 restart joblink-v2 && rm /tmp/.joblink-deploy-active"
    echo ""
    exit 1
  fi
fi

# Pass through to real pm2
/usr/lib/node_modules/pm2/bin/pm2 "$@"
