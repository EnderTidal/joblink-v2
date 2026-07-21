# Build Prompt: JobLink V2.0

You are building **JobLink V2.0** end-to-end, in one pass. This prompt is self-contained — everything you need is below. If a `docs/PROJECT_BRIEF.md`, `SHAPE.md`, or repo scaffold is attached alongside this prompt, treat those as authoritative and this as the executive summary of them.

## 1. What JobLink Is and Why

JobLink produces **self-selected, interested candidates** for Job Orders. Filling job orders is how Express franchises make money — every candidate this surfaces is directly tied to that.

It does this with two things working together: it stores **Job Orders** (open positions), and it sends candidates a **"Magic Blast"** — a text with a personal link — letting them know about jobs and tracking who got it and when.

Both Job Orders and contact lists (names + phone numbers) originate from **Q4**, Express's source-of-truth system. Recruiters export from Q4 and bring files into JobLink — this is a manual export/upload flow for now, not a live integration.

**North star:** keep it as close to "just a DB and a parser" as possible. Resist scope creep.

## 2. Who Uses It

- **Recruiters** — the only real end users, running job orders and blasts
- **Admin** — settings, feedback, changelog, credentials

## 3. The Interface: "Tom"

"Tom" is not a person — it's the name of the primary interface. It looks and behaves like a chat box with four fixed buttons:

1. **New Job Order**
2. **Send Magic Blast**
3. **Review Magic Blasts**
4. **Help / Tutorial / FAQ**

## 4. Core Architecture Principle: Hybrid Vigor

Pair a **deterministic** structure (fixed, predictable paths) with **non-deterministic** help (AI reading and making sense of free text or documents) — side by side, not one instead of the other.

- The four buttons are a fixed branching point. Picking one commits the user to that path for the rest of the conversation.
- Once inside a path, the AI (a Claude tool call) handles the flexible part: understanding whatever's typed or uploaded.
- Switching to a different button requires a **new conversation** — this keeps each path's tool calls cleanly separated.

### 4a. New Job Order — required flow

1. User picks **New Job Order**
2. System asks: type in the details (show an example), or upload a file
3. User uploads a document (or types)
4. A tool call parses the file into the Job Order template fields
5. System shows the filled-out Job Order in the chat
6. User can: say "yes, publish" / type free text telling it what to fix / edit any field directly
7. User says "done with job order" → publishes to the job board (or stays unpublished, their call)
8. System asks if they want to do another (loop to step 2)

### 4b. Send Magic Blast — required flow

1. User picks **Send Magic Blast**
2. System asks: manually enter names + phone numbers, or upload a contact list
3. User enters/uploads (Excel, CSV, etc.)
4. A tool call parses the list and sets up the blast — optionally sorting/limiting by an ephemeral "Last Contacted" value if the user wants a subset like "the 300 most recent" (see Section 6)
5. System **requires positive confirmation of category** — Industrial, Administrative, or Skilled Trade. Cannot be skipped or assumed.
6. System shows a preview of the full blast
7. User must give **positive affirmation via an actual button press** (not typed "yes") before anything sends — this is a stronger gate than New Job Order's, because sending real texts is harder to undo than saving a draft
8. Blast Guard (Section 7) is applied automatically — anyone still in cooldown is skipped, and the user sees a result count, e.g. "287 sent, 13 skipped (cooldown)"
9. Blast sends; system confirms completion
10. System asks if they'd like to send another (loop to step 2)

### 4c. Review Magic Blasts — required flow

Simpler than the other two — a report view, no upload, no confirmation gate.

1. User picks **Review Magic Blasts**
2. System shows recent blast activity: number sent, number of interested replies

Candidates mark "interested" **themselves, directly on the magic link page** — not by texting back. This is a self-contained interaction; it does not require any inbound-message parsing from the messaging provider.

### 4d. Help / Tutorial / FAQ — required flow, with a hard constraint

1. User picks **Help / Tutorial / FAQ**
2. They ask a question in plain language
3. The system answers directly, and — if useful — generates a **simulated walkthrough on the fly, tailored to the question** (not a fixed script)
4. Every simulated example must be **clearly marked as a demo**

**Hard constraint: this path must never make a real tool call.** It cannot write to the real database, send a real text, or publish a real job order under any circumstances, no matter how the request is phrased. This needs an explicit test proving that guarantee (see Section 9).

## 5. Data Model

**Candidate**
- `phone_number` — **Primary Key**
- `magic_link` — Foreign Key, tied to phone number
- `first_name`, `last_name`
- `last_blast` (date) — drives Blast Guard (Section 7). This is the *only* contact-recency field stored.
- `blast_count`

Do **not** add a persistent "last contacted" field — see Section 6.

**Job Order**
- Standard job order fields (title, description, etc. — parsed from the uploaded document)
- `category` — one of: Industrial, Administrative, Skilled Trade. This belongs to the Job Order, never the candidate.
- `status` — Published / Unpublished / Complete (used by Dashboard filters)

**Interest** (join table)
- `candidate_id` (phone number)
- `job_order_id`
- Marked when a candidate clicks "interested" on their magic link page

Interest is per candidate-per-job-order, not a single flag on the candidate — someone can be interested in one job and not another.

## 6. Last Contacted: Transient, Never Stored

An uploaded contact list can optionally include a "Last Contacted" date per person. This is used **only** to let the user select a subset to blast (e.g. "the 300 most recently contacted"):

1. Upload the list with Last Contacted dates
2. Sort in-memory by Last Contacted, newest first (not a DB query — nothing is stored)
3. Take the requested number
4. Blast Guard still filters this selection (Section 7)
5. Once the blast is sent, discard the Last Contacted values entirely — never write them to the Candidate record

## 7. Blast Guard (Cooldown Rule)

- A candidate cannot receive a new magic link until **N days** have passed since their `last_blast` (default: **3**)
- This must be an **admin-configurable setting**, not hardcoded
- **Global, not per-category**: one blast of any category resets the clock for that candidate

## 8. The Overwrite Rule

On import, if a phone number already on file arrives with a **different name**:
- Overwrite: the name
- Never touch: `last_blast`, `blast_count`

Everything else about that candidate's history is untouched. Phone number is the anchor (PK); magic link depends on it (FK).

## 9. How the Magic Link Works (Candidate-Facing Page)

- The link is tied to a **category**, not a single job. The candidate sees every currently **Published** job order in that category and self-selects.
- The candidate can mark themselves "interested" in any job right there on the page (Section 4c, Section 5).
- Unpublished or Complete job orders never show up here.

## 10. Importing Data

- **Job Orders**: type in manually, or upload `.doc`, `.docx`, or `.txt`
- **Contact lists**: type in manually, or upload `.csv` or Excel formats — need first name, last name, phone number, optionally Last Contacted (Section 6)
- **Parser requirement**: handle the case where name arrives as one combined column (e.g. "John Smith" in a single cell) — split it into first/last reliably. This needs a dedicated test.

## 11. Screens

- **Dashboard** — filtered views: Publish / Unpublish / Complete / etc.
- **"Tom"** — the chat interface (Sections 3–4)
- **Admin**:
  - Settings, Feedback, Changelog/patch log
  - Templates for blast messages
  - User management
  - Credential management for the messaging provider (Section 12)
  - Onboarding flow for entering messaging credentials correctly

## 12. Messaging Provider: Build This Swappable

The current messaging provider is **Whippy**, but it's an explicitly known placeholder — a replacement called **Relay** is coming soon. Build the messaging integration behind a clean interface/boundary so that swap, when it happens, requires **zero changes** to Job Order, Magic Blast, or Blast Guard logic. Don't hardcode Whippy specifics into core business logic anywhere.

## 13. What It Should Feel Like

Fast, intuitive, robust, guardrailed, consistent.

## 14. Explicitly Out of Scope Right Now

- Help/FAQ making real tool calls (Section 4d) — never
- Job Order category as a candidate field (Section 5) — it isn't one
- Persisting "Last Contacted" (Section 6) — don't
- Zero data retention, nurture sequences, matched-jobs auto-suggestion — nice-to-haves, not required this pass

## 15. Known Gaps To Design Extension Points For (Not Full Spec Yet)

These came from the prior version of this system and are known to be missing from this spec — don't build them fully, but don't architect in a way that makes adding them hard later:

- **Closing Whippy (or Relay) conversations** that open when a Magic Blast goes out
- **Assigning candidates to recruiters** — some notion of ownership over a candidate or job order

## 16. How to Build It

- **Pick a tech stack.** None is mandated. Choose something simple and appropriate for "a DB and a parser" plus a chat-style AI interface with file uploads and an SMS integration. **Document your choice and reasoning** in `docs/DECISIONS.md`.
- **Testing, from day one, in two flavors:**
  - *Deterministic* (Blast Guard, Overwrite Rule, the name-splitting parser, publish/unpublish, category confirmation gate): exact-match tests. Wrong output = failing test.
  - *AI-assisted* (document → Job Order field extraction): evaluation-style tests — check the right information was extracted, not exact wording.
  - The Help/FAQ sandbox needs its own test proving it **never** performs a real write/send/publish, regardless of what's asked of it.
- **Maintain a `SHAPE.md`** — a living, plain-language map of the repo for any AI or human picking it up cold: what it does, how it's organized, the rules that must never be silently broken (Blast Guard, Overwrite Rule, Last Contacted non-persistence, Help/FAQ's real-tool-call ban).
- **Clarify → Delete → Optimize → Accelerate → Automate.** Nail down what's required first. Cut anything not essential before optimizing anything. Don't automate things that shouldn't exist in the first place.
- **Steady, disciplined pace** over big-bang, half-finished features.
- **Safety margins before you need them.** Confirmation gates should scale with how reversible the action is — Send Magic Blast (hard to undo) gets a harder gate (real button press) than New Job Order (a draft, easy to undo).
- **Prove risky pieces small before committing big** — a small working slice of a risky feature before the full build.

## 17. Deliverable

A working repository containing:
- Application code implementing all four Tom paths, the data model, Blast Guard, the Overwrite Rule, and the swappable messaging boundary
- Both test suites (deterministic + AI-assisted), passing
- `SHAPE.md`, `docs/DECISIONS.md` (including your tech stack choice + reasoning), and an updated `CHANGELOG.md`
- Extension points (not full implementations) for the two known gaps in Section 15

Build it in one pass. Where this prompt is ambiguous or silent, make the most reasonable call, and **log that decision in `docs/DECISIONS.md`** rather than guessing silently.
