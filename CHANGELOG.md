# Changelog

## 0.1.0 — Scaffold
- Repo created from the finalized JobLink project brief
- Folder structure laid out for the four "Tom" paths, plus Admin
- Shape file and decisions log added
- No application code yet — tech stack still to be picked (see brief, Section 16)

## 0.1.1 — Porting checklist
- Added `docs/PORTING_FROM_V1.md` — living list of known V1 logic to excavate (Whippy conversation closing, recruiter assignment)
- Brief updated with new Section 18 covering this

## 0.1.2 — Fable build prompt
- Added `docs/FABLE_BUILD_PROMPT.md` — self-contained one-shot build prompt covering the full spec, architecture, data model, and build philosophy

## 2.0.0 — First working build (2026-07-21)
- **Tech stack decided and built**: Node.js + Express + built-in SQLite (`node:sqlite`), plain HTML pages, zero build step — see `docs/DECISIONS.md`
- **All four Tom paths working**: New Job Order (parse → review → edit → publish), Send Magic Blast (category gate → guard-first preview → button-press send), Review Magic Blasts, Help/FAQ sandbox
- **Data model** per brief §5 + spec-review fixes: candidates, job_orders, **blasts** (new), blast_recipients, interests (blast-attributed), templates, settings, users, feedback, changelog
- **Blast Guard**: 72h default (admin-configurable), global across categories, applied before the preview, `do_not_contact` = infinite cooldown
- **Overwrite Rule, phone normalization, name splitting** — implemented with exact-match tests
- **Swappable messaging boundary**: Whippy client ported from V1 behind a provider interface; mock provider is the safe default; conversation-closing ported
- **Candidate magic link page**: server-rendered, shows Published jobs in the most-recent-blast category, one-tap "I'm Interested"
- **Dashboard** (stats, filters, publish/unpublish/complete actions) and **Admin** (settings, templates, users, candidates + DNC, feedback, changelog)
- **Tests**: 61 deterministic + 6 parser evals + 9-step end-to-end smoke — all green

## 2.0.1 — Onboarding wizard (2026-07-21)
- Ported V1's first-login setup wizard (`public/onboarding.html`): welcome → change the default password → connect Whippy with V1's step-by-step instructions and tutorial screenshots (`public/tutorial/`) → live Test Connection → done
- Skippable (stays in safe mock mode); re-runnable via Admin → Settings → "Re-run setup wizard"
- New: `onboarded` setting, `needsOnboarding` on login, `POST /api/me/password` (requires current password), `POST /api/onboarding/complete|reset` (admin-only)
- V1's webhook setup step intentionally deferred until the inbound STOP webhook is ported
- Tests: +6 deterministic (67 total), smoke now 10 steps — all green
