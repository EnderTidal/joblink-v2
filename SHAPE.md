# Shape File — JobLink V2.0

*This file exists so any AI (or human) working in this repo understands what it's looking at before touching anything. Keep it updated as the codebase grows — it's a map, not a one-time snapshot.*

**Last updated: 2026-07-21 (v2.0.0 — first working build)**

## What this is

JobLink produces self-selected, interested candidates for Job Orders. Full spec: `docs/PROJECT_BRIEF.md`. Read that before making any product decision — this file is about orientation, not requirements.

## Tech stack (decided 2026-07-21 — see docs/DECISIONS.md)

Node.js (≥22.13) + Express + **SQLite via the built-in `node:sqlite`** (zero native dependencies) + plain HTML pages (no SPA, no build step). AI parsing uses the Anthropic SDK when `ANTHROPIC_API_KEY` is set, with a deterministic fallback parser that works with no key at all. `npm install && npm start` is the entire setup.

## The core shape

- Everyone interacts through **"Tom"** — a chat interface with four fixed paths (New Job Order, Send Magic Blast, Review Magic Blasts, Help/FAQ). One path per conversation. The state machines live in `src/tom.js`; they are deterministic — AI only parses uploads/free text inside a step (Hybrid Vigor).
- Core entities: **Job Order**, **Candidate** (keyed by 10-digit normalized phone), **Blast** (one row per blast sent — powers Review + recruiter attribution), **Interest** (candidate × job order, attributed to a blast), plus blast_recipients, templates, settings, users, feedback, changelog.
- The AI's job at each step is narrow: parse a document or list into a fixed template. It doesn't freelance outside that.

## Map

```
server.js               — bootstrap: db, auth, routes, static
src/
  db.js                 — schema + settings + magic tokens (node:sqlite)
  phone.js              — THE normalization rule: everything stored as 10 digits
  names.js              — "John Smith" / "Smith, John" splitting
  blast-guard.js        — cooldown rule (pure functions, no clock of its own)
  importing.js          — CSV/Excel parsing, Overwrite Rule, ephemeral Last Contacted
  blast.js              — plan (guard BEFORE preview) + execute (paced, partial-send safe)
  job-orders.js         — the 8 canonical fields, validation, dashboard actions
  tom.js                — the four path state machines + confirmation gates
  candidate-page.js     — server-rendered magic link page (/m/<token>)
  ai/parse-job-order.js — doc → fields (Claude when key set, deterministic fallback)
  ai/help-faq.js        — the SANDBOX (see rules below)
  messaging/            — the swappable boundary: index (selector), whippy, mock
routes/                 — auth, tom, admin (+dashboard APIs + onboarding), public (magic link)
public/                 — login, onboarding wizard, tom, dashboard, admin + one shared css/js
public/tutorial/        — Whippy setup screenshots (ported from V1, used by the wizard)
tests/deterministic/    — exact-match tests (61)
tests/ai-assisted/      — evaluation-style tests for the parser
scripts/smoke.js        — boots the real server, walks the product end-to-end (9 steps)
```

## Rules that must never be silently broken

- **Blast Guard** (`src/blast-guard.js`): no candidate gets a new magic link within the cooldown window (default **72 hours** — "3 days" is defined as exactly 72h), globally, regardless of category. `do_not_contact = 1` (STOP replies) is an infinite cooldown that nothing overrides. Guard runs **before** the preview so the recruiter confirms real counts.
- **Overwrite Rule** (`src/importing.js`): on a phone-number match, only the name is overwritten. `last_blast`, `blast_count`, `magic_token`, `do_not_contact` never change on import.
- **Last Contacted** is never stored. It rides along with an upload, is used once to sort/limit, and is discarded. There is no column for it — the test asserts this structurally.
- **Help/FAQ sandbox** (`src/ai/help-faq.js`): never allowed to make a real tool call. It imports no db/messaging/write modules (a test greps for this) and adversarial prompts are proven to leave the DB byte-identical.
- **Phone normalization** (`src/phone.js`): every number stored as exactly 10 digits. If this breaks, Blast Guard silently fails — which is why it has its own exact-match suite.
- **Partial-send rule** (`src/blast.js`): a failed send never burns a candidate's cooldown. Only provider-accepted sends update `last_blast`/`blast_count`.
- **The send gate**: Send Magic Blast requires the literal button action `confirm_send`. Typed "yes" is rejected by design — there's a test for it.
- **Messaging boundary** (`src/messaging/`): core modules never import the Whippy client or mention its API. Swapping to Relay = one new file + one setting. A structural test enforces this.

## Testing philosophy (two flavors — both exist, both pass)

- **Deterministic logic** → exact-match tests (`npm test`, 61 cases): Blast Guard boundaries, the Overwrite Rule, phone normalization costumes, name splitting, the send gate, the sandbox.
- **AI-assisted parsing** → evaluation-style tests (`npm run test:ai`): grade that the right information was extracted from sample docs, not exact wording. Runs against the fallback engine always; grades the Claude engine too when `ANTHROPIC_API_KEY` is set.
- **End-to-end** → `npm run smoke`: boots the real server on a fresh DB and walks login → job order → gated blast → magic link → interest → review → sandbox attack. Never sends a real SMS.

## Safety defaults

- Fresh installs use the **mock** SMS provider — real texts are impossible until Whippy credentials are entered in Admin → Settings and the provider is switched.
- First boot seeds `admin` / `joblink2026`; the first admin login routes into the onboarding wizard (password change + guided Whippy setup, skippable into mock mode; re-runnable from Admin → Settings).
- Magic link tokens are random (`crypto.randomBytes`), never derived from the phone number.

## Extension points (deliberately thin — see PORTING_FROM_V1.md)

- `candidates.assigned_recruiter` + `job_orders.assigned_recruiter` columns exist but aren't surfaced in UI yet.
- `provider.closeOpenConversations()` is called after each blast (Whippy impl ported from V1; mock no-ops).
- `blasts.sent_by` records which recruiter sent each blast.
