# JobLink V2.0

JobLink produces self-selected, interested candidates for Job Orders — for Express franchises, filling job orders is the business.

**Status: working build (v2.0.0, 2026-07-21).** All four Tom paths, the data model, Blast Guard, the Overwrite Rule, the swappable messaging boundary, and both test suites — green.

## Run it

```bash
npm install
npm start          # → http://localhost:3000  (login: admin / joblink2026 — change it!)
```

Requires Node.js 22.13+ (uses the built-in SQLite — no database server, no native builds). The database is a single file in `data/`.

Optional: set `ANTHROPIC_API_KEY` to turn on Claude-powered document parsing and smarter Help answers. Without it, everything still works — a deterministic parser and built-in FAQ take over.

SMS starts in **mock mode** (no real texts can be sent). To go live: Admin → Settings → enter Whippy credentials → switch provider to Whippy → Test connection.

## Test it

```bash
npm test           # 61 exact-match tests: Blast Guard, Overwrite Rule, phone rules, gates, sandbox
npm run test:ai    # evaluation-style tests for the document parser (grades Claude too if key set)
npm run smoke      # boots the real server, walks the whole product end-to-end (9 steps)
```

## Start here

- `docs/PROJECT_BRIEF.md` — the full spec: what this does, every rule and edge case
- `SHAPE.md` — the map of this repo + the rules that must never be silently broken
- `docs/DECISIONS.md` — every resolved design call, including the 2026-07-21 build decisions
- `docs/PORTING_FROM_V1.md` — what was excavated from V1, and what's still worth mining
- `docs/SPEC_REVIEW_2026-07-21.md` — the pre-build review whose fixes are now built in

## Structure

- `src/` — core logic (db, phone, names, blast-guard, importing, blast, job-orders, tom, candidate-page)
- `src/messaging/` — the swappable SMS boundary (Whippy today, Relay later, mock for safety)
- `src/ai/` — the two AI seams: job-order parsing + the Help/FAQ sandbox
- `routes/` + `public/` — Express routes and the four screens (login, Tom, Dashboard, Admin)
- `tests/deterministic/` + `tests/ai-assisted/` — the two test flavors
- `scripts/smoke.js` — end-to-end proof over real HTTP
