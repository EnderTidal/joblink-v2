# Decisions Log

A running list of resolved design calls, with a pointer to the brief section that explains the "why." Add to this as new decisions get made — don't rewrite history, just append.

| Decision | Resolution | Brief Section |
|---|---|---|
| Who "Tom" is | Not a person — it's the chat interface itself | §3 |
| Blast Guard scope | Global cooldown (any category resets the clock), not per-category | §7 |
| Last Contacted on import | Not stored at all — used once per upload, then discarded | §5, §8 |
| Overwrite Rule | Only name gets overwritten on a phone-number match | §9 |
| Interest tracking | Per candidate *per job order*, not a single flag on the candidate | §5 |
| How interest gets marked | Candidate marks it themselves on the magic link page — not via SMS reply | §4, §6 |
| Help/FAQ tool calls | Never real — AI-generated simulated walkthroughs only, clearly marked as demos | §4 |
| Messaging provider | Whippy today, but it's a known placeholder — Relay is the planned replacement | §1, §17 |
| Data source | Job Orders + contact lists both originate from Q4 (Express's source-of-truth system) | §1, §12 |
| V2.0 vs V1 status | V2.0 is the master template; V1 (`/home/user/joblink`) gets excavated for useful logic, not used as the base | `PORTING_FROM_V1.md` |

## Appended 2026-07-21 — build decisions (from SPEC_REVIEW_2026-07-21.md + build)

| Decision | Resolution | Why |
|---|---|---|
| **Tech stack** | Node.js (≥22.13) + Express + SQLite via built-in `node:sqlite` + plain HTML pages, no build step | Truest to "just a DB and a parser": zero native/database dependencies, `npm install && npm start` runs anywhere (Windows dev box or the KWF VPS under PM2), and the whole test suite runs with no setup. V1 patterns (Express, plain pages, PM2) carry over. If multi-office scale ever demands Postgres, the SQL is standard enough to migrate — that's a cannonball we fire only after the bullet lands. |
| **Blast table added** | 4th core table `blasts` (+ `blast_recipients` per-recipient log), `interests.blast_id` attribution | Review Magic Blasts is impossible without it; also solves recruiter attribution (`sent_by`) flagged in PORTING_FROM_V1 |
| **Magic link ↔ category** | **Most recent blast wins.** `candidates.current_category` is updated on each accepted send; the permanent link shows Published jobs in that category | Simplest rule consistent with "one link per candidate" + "link tied to a category"; the category effectively lives on the blast |
| **Phone normalization** | All numbers stored as digits-only, 10-digit US format (`src/phone.js`); one deterministic rule + exact-match tests for every messy variant | Phone is the PK — without one canonical form, duplicates appear and Blast Guard silently fails |
| **"3 days" defined** | Exactly **72 hours** from the `last_blast` timestamp; admin-configurable in hours | Exact-match tests can't grade a fuzzy word |
| **Job Order fields enumerated** | title, category, pay, shift_hours, location, requirements, description, status — required: title, category, pay, status | The parser, evals, and candidate page all need one canonical list |
| **SMS opt-out** | `do_not_contact` flag on Candidate; Blast Guard treats it as an infinite cooldown; settable from Admin → Candidates (and by inbound STOP webhook when wired to the provider). Templates end with "Reply STOP to opt out" | TCPA basics; suppression must live in OUR data so the Whippy→Relay swap can't lose it. *Not legal advice — get a real compliance check before high-volume sending.* |
| **Blast Guard position** | Applied **before** the preview — recruiter confirms "287 will be sent, 13 skipped," not a surprise afterward | Confirmation gates should show what will actually happen |
| **Partial-send failure** | `last_blast`/`blast_count` update only for provider-accepted sends; blast record stores sent/failed counts; failed recipients keep their cooldown unburned | A failed blast must not burn 300 cooldowns for texts nobody got |
| **Template selection** | Blast flow uses the default template automatically; the preview offers a template switcher; templates without `{link}` are rejected | Missing step in the original flow; default-template rule keeps it fast |
| **Publishing later** | Dashboard rows have Publish / Unpublish / Complete action buttons | Closes the "only stated way to publish is inside the chat" gap |
| **Magic link tokens** | `crypto.randomBytes(16)` base64url — random, never derived from the phone number | Predictable links would let anyone enumerate candidates and fake interest |
| **Send gate mechanics** | Only the literal button action `confirm_send` sends; typed "yes"/"confirm"/"go" are rejected with an explanation (tested) | The brief's "positive affirmation via an actual button press," made enforceable |
| **Staged one-pass build** | Built as: data model + rules + tests → messaging boundary → candidate page → Tom paths → screens → smoke E2E. Each layer's tests passed before the next was built | The one-pass build treated as the bullet, staged so a data-model problem surfaces at hour two, not hour twenty |
| **Fresh-install SMS safety** | `sms_provider` defaults to `mock` (records sends, touches nothing); Whippy activates only when creds are entered and the provider is switched | Safety margins before we need them |
| **Legacy .doc files** | Best-effort text extraction; if unreadable, the user is asked to re-save as .docx/.txt | Real .doc parsing needs heavy dependencies; Q4 exports are moving to .docx anyway |
| **Auth** | Minimal: bcrypt + http-only session cookie, seeded `admin`/`joblink2026` with a change-it nag. No MFA in this pass | V2 is single-office; V1's TOTP can be ported later if needed (logged in PORTING_FROM_V1) |
| **Onboarding wizard** | First admin login routes to `/onboarding.html`: change password → Whippy credentials (V1's screenshots + instructions) → Test Connection → done (`onboarded` setting). Skippable — skipping keeps mock mode. Re-runnable from Admin → Settings. Webhook step omitted until the STOP webhook exists | Brief §11 requires it; V1's wizard was the reference. A wizard step that configures a webhook nothing listens to would be a lie |
