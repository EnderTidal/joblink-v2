# KWF Dev Dashboard — Roadmap

## Security (Priority 1)

### 2FA (Two-Factor Authentication)
- [ ] Add TOTP-based 2FA (Google Authenticator / Authy compatible)
- [ ] Require 2FA for all super admin accounts (org_id=1)
- [ ] Optional 2FA for regular admin accounts
- [ ] Recovery codes (one-time backup codes)
- [ ] Libraries: `otpauth` or `speakeasy` + `qrcode`

### Email Verification
- [ ] Require email verification on signup before granting access
- [ ] Re-verify email on email change
- [ ] Verification tokens with expiry (24h)
- [ ] Resend verification flow

### Session Security
- [ ] Secure cookie flags (HttpOnly, SameSite=Strict, Secure)
- [ ] Session timeout (configurable, default 8h)
- [ ] Force re-auth for sensitive actions (billing changes, user management)
- [ ] Rate limiting on login attempts (brute force protection)

### Auth Hardening
- [ ] Password complexity requirements (min 8 chars, 1 number, 1 special)
- [ ] Password reset flow via verified email only
- [ ] Audit log for auth events (login, logout, failed attempts, 2FA changes)
- [ ] CSRF protection on all state-changing endpoints

---

## Financial Dashboard (Priority 2)

### Mercury Banking Integration
- [ ] Mercury API connection for real-time balance
- [ ] Transaction categorization (auto-match to QBO accounts)
- [ ] Monthly reconciliation with QBO
- [ ] Balance display on finances dashboard

### Tom AI Usage Metering
- [ ] Instrument `src/ai/parse-job-order.js` to log token usage per API call
- [ ] Instrument `src/ai/help-faq.js` to log token usage (when using Claude)
- [ ] Create `tom_usage` table: org_id, model, input_tokens, output_tokens, estimated_cost, timestamp
- [ ] Calculate per-org AI costs using Anthropic pricing (Haiku: $0.25/$1.25 per Mtok)
- [ ] Include Tom AI costs in COGS calculator alongside Retell costs
- [ ] Display per-org AI usage on finances dashboard

### Expense Tracking
- [ ] Categorize recurring expenses (Hostinger, Cloudflare, Resend, Retell base, Anthropic, Embroker)
- [ ] Manual expense entry for non-API expenses
- [ ] Monthly expense comparison (trend over time)
- [ ] Alert when expenses exceed budget thresholds (per OA §6.3)

### Distribution Automation
- [ ] Monthly distribution waterfall calculation (auto on 1st of month)
- [ ] Tax vault tracking (segregated 35% reserve)
- [ ] Operating reserve tracking against 6x target
- [ ] Founder draw ledger (historical draws by founder)
- [ ] Distribution approval workflow (both founders sign off per OA)

### Historical Backfill
- [ ] Import all Stripe transactions since inception into QBO
- [ ] Backfill ResumeLine COGS invoices (Jun, Jul, Aug 2026)
- [ ] Reconcile Stripe payouts with Mercury deposits

---

## Infrastructure (Priority 3)

### Monitoring & Alerting
- [ ] Uptime monitoring for all services (JobLink, ResumeLine, BillyFit)
- [ ] Stripe webhook health monitoring
- [ ] QBO token expiry alerts (auto-refresh + alert if refresh fails)
- [ ] Monthly financial report generation (PDF export)

### Compliance & Tax
- [ ] CPA-ready export (chart of accounts, P&L, balance sheet)
- [ ] Tax vault tracking report (for estimated quarterly payments)
- [ ] 1099 tracking for contractors (if applicable)
- [ ] Annual P&L and balance sheet generation

### Multi-Tenant Finance
- [ ] Per-org revenue tracking (as customer count grows)
- [ ] Per-org COGS rollup (Retell + AI per customer)
- [ ] Customer lifetime value calculation
- [ ] Churn impact on financial projections

---

## Current Status

### Completed (Aug 28, 2026)
- [x] QBO OAuth integration (production, Kingdom Workforce)
- [x] Chart of Accounts (12 custom accounts: 4 revenue, 4 COGS, 4 expense)
- [x] Customer setup (Express Employment - Waxahachie = Matt)
- [x] COGS calculator (pulls Retell costs from ResumeLine PostgreSQL)
- [x] Invoice creation + email (QBO API)
- [x] P&L report (live from QBO)
- [x] Finances dashboard v2 (tabbed, OA-compliant)
- [x] Distribution waterfall calculator (35% tax, 6x reserve, 55/45 split)
- [x] Founder draw calculator
- [x] Operating reserve health tracker
- [x] Matt franchise COGS panel (OA §5.5b compliant)
- [x] Stripe activity feed (last 30 days)
- [x] QBO invoice management

### Known Gaps
- Mercury balance not yet integrated (API access needed)
- Tom AI usage not metered (no cost data per API call)
- No 2FA on any accounts
- No email verification on signup
- Stripe webhook signature verification failing (stale secret)
- Operating reserve calculation needs Mercury balance to be accurate
- Historical transactions not yet backfilled into QBO
