# Porting from JobLink V1

**V1 repo location (local):** `/home/user/joblink` (also `joblink-repo` on the Desktop)

V2.0 (this repo) is the **master template** going forward. V1 isn't the base — it gets excavated for real, working logic worth bringing over, not rebuilt from scratch.

## Ported in the 2026-07-21 build

- [x] **Whippy API client** — pure client, no DB knowledge (`src/messaging/whippy.js`, from V1 `lib/whippy.js`)
- [x] **Closing Whippy conversations** — `provider.closeOpenConversations()` called after every blast
- [x] **10 sends/sec pacing** — `SMS_RATE_LIMIT_MS = 100` awaited in the blast loop (from V1 `lib/blast.js`)
- [x] **Template placeholders** — `{first_name}` / `{link}`, template without `{link}` rejected (V1 rule)
- [x] **"Reply STOP to opt out"** — default template language (V1 default), backed by the new `do_not_contact` flag
- [x] **"Last, First" name convention** — Q4 exports names comma-style; the splitter handles it (V1 renderMessage logic, now tested)
- [x] **Recruiter attribution (partial)** — `blasts.sent_by` + `assigned_recruiter` columns as extension points
- [x] **Mock-first send safety** — V1's staging gate generalized: fresh installs can't send real texts at all
- [x] **Onboarding wizard** (added same day) — first-login setup ported from V1's `onboarding.html`: password change → Whippy credentials with V1's step-by-step instructions and tutorial screenshots (API key via Settings → Developers, From Number via Channels' Sender column, Channel ID via the Place ID field) → live Test Connection → done. Skippable (stays in mock mode); re-runnable from Admin → Settings. V1's webhook setup step was deliberately left out until the inbound STOP webhook is ported (below).

## Still to excavate (grow this list as V1 gets reviewed)

- [ ] **Inbound STOP webhook** — V1 has `/webhooks/whippy/inbound` (routes/pipeline.js); V2 has the `do_not_contact` flag + admin toggle but no webhook wiring yet. Port when Whippy creds go live (or build against Relay directly).
- [ ] **Assigning candidates to recruiters (full feature)** — columns exist; UI/routing rules don't. V1's recruiter-routing (migration 008) is the reference.
- [ ] **Link click tracking** — V1's `joblink_link_clicks`; useful for blast quality review.
- [ ] **TOTP MFA** — V1 has otplib-based optional MFA per admin; port if/when V2 leaves single-office use.
- [ ] **Bcrypt migration pattern** — V1's transparent SHA-256→bcrypt rehash on login (not needed fresh, noted for data migration).
- [ ] **Candidate exclusions ("on assignment")** — V1 concept; decide whether V2 wants it or whether do_not_contact + cooldown covers the need (deletion candidate).
