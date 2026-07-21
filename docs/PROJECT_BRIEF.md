# Project Brief: JobLink

*Compiled from project notes — July 21, 2026*

## 1. The Big Idea

**JobLink is a system that produces self-selected, interested candidates for Job Orders.**

**Why this matters:** filling job orders is how Express franchises actually make money. Every candidate JobLink surfaces is progress toward that.

It does this through two things working together:
1. Stores **Job Orders** (open positions to fill)
2. Sends candidates a **"Magic Blast"** — a text message with a personal link — letting them know about jobs, and tracks who got it and when

Both the Job Order details and the contact lists (names + phone numbers) originate from **Q4**, Express's source-of-truth documentation system (Section 12 has the file formats this arrives in).

The candidate does the matching themselves (Section 6) and tells us they're interested (also Section 6) — recruiters don't have to manually sift and match. That's the whole point.

From the notes: **"It's literally just a DB and a parser. That's it!"**
That's the north star — keep it that simple. (It also drives the actual messaging through **Whippy** — for now. Whippy isn't permanent; a replacement platform called **Relay** is coming soon, so this is a known placeholder, not a long-term dependency. Section 11's Admin credentials cover this, and Section 17 has the build implication.)

## 2. Who Uses It

- **Recruiters** — the main users, running job orders and blasts
- **Admin** — settings, feedback, changelog/patch log

## 3. The Primary Interface ("Tom")

"Tom" isn't a person — it's the name of the main interface recruiters use. It's designed to look and feel like a chat box, with four buttons across the top:

| Button | What it does |
|--------|--------------|
| **New Job Order** | Upload a file or type it in → review/confirm the details → done |
| **Send Magic Blast** | Upload a file or type it in → review/confirm → send |
| **Review Magic Blasts** | Check the data quality/quantity of a past blast |
| **Help / Tutorial / FAQ** | Answers questions and can generate tailored, simulated walkthroughs — never a real tool call |

## 4. Hybrid Vigor: How "Tom" Actually Works

This is a guiding principle behind the whole interface: pair a **deterministic** structure (fixed, predictable paths) with **non-deterministic** help (AI reading and making sense of free text or documents) — the two working side by side, not one instead of the other.

- The four buttons (Section 3) are a fixed branching point — picture a single node with four fixed ways out. Picking one commits the recruiter to that path for the rest of the conversation.
- Once inside a path, the AI takes over the flexible part: understanding whatever the recruiter types or uploads.
- To switch to a different one of the four buttons, the recruiter starts a **new chat**. This keeps each path's tool calls separate and stops the conversation from turning into a tangled mess.

**Worked example — New Job Order:**

1. Recruiter picks **New Job Order**
2. Tom asks them to either type in the details (with an example shown) or upload a file
3. Recruiter drags/drops or selects a document
4. A tool call runs Claude to parse the uploaded file into the Job Order template fields
5. Tom shows the filled-out Job Order right in the chat
6. Recruiter can then:
   - Say "yes, publish"
   - Type free text telling Tom what to fix
   - Click into any field and edit it directly
7. When they're happy, they say "done with job order" → it publishes to the job board (or stays unpublished, if that's their call)
8. Tom asks if they want to do another Job Order (loops back to step 2)

**Worked example — Send Magic Blast:**

1. Recruiter picks **Send Magic Blast**
2. Tom asks them to either manually enter names and phone numbers, or upload a list of contacts
3. Recruiter manually enters, or drags/drops, or clicks upload and selects a file (Excel, etc.)
4. A tool call runs Claude to parse the list and set up the blast — this may or may not involve sorting/limiting by Last Contacted (Section 8)
5. Tom requires **positive confirmation of the category** this blast is for — Industrial, Administrative, or Skilled Trade (Section 10). This step can't be skipped or assumed.
6. Tom shows a preview of the full blast
7. Recruiter must give **positive affirmation — an actual button press**, not just a typed "yes" — before anything sends
8. The blast goes out; Tom confirms once it's complete
9. Tom asks if they'd like to send another (loops back to step 2)

*Notice this flow has a stronger confirmation gate than New Job Order — a real button press instead of typed confirmation. That tracks: sending real texts to real people is much harder to undo than saving a draft job order.*

**Worked example — Review Magic Blasts:**

This one's simpler than the other two — no upload, no AI-parsed template, no confirmation gate. It's a report.

1. Recruiter picks **Review Magic Blasts**
2. Tom shows recent magic blast activity, including:
   - Number of blasts sent out
   - Number of interested replies (candidates who responded showing interest)

*Candidates mark themselves "interested" directly on the magic link page itself — not by texting back. So this is a simple, self-contained interaction we own end-to-end, not a two-way integration with Whippy. It does mean we need to store which candidate marked interest in which job order, so it can be counted and reported here.*

**Worked example — Help / Tutorial / FAQ:**

1. Recruiter picks **Help / Tutorial / FAQ**
2. They ask a question in plain language (e.g. "what happens if I upload the wrong file type?")
3. Claude answers directly — and if a walkthrough would help, it generates one **on the fly, tailored to the actual question**, rather than pulling from a fixed script
4. Every simulated example is clearly marked as a **demo** — nothing shown here is ever saved, sent, or published

*This is the one button that never makes a real tool call, by design. It can describe or mock up what any of the other three flows would look like, but it's a sandbox — the walkthroughs are generated fresh each time, not fixed screenshots, but they never touch real data.*

## 5. Candidate Record (the core data)

Each candidate needs:
- **Phone number** — this is the **Primary Key**. Every candidate is identified by their phone number, above all else.
- **Magic link** — tied to the phone number (Foreign Key)
- First name, last name
- **Last Blast** (date) — when *we* last sent this person a magic link. Drives the Blast Guard cooldown (Section 7).
- Number of blasts sent

**Note:** "Last Contacted" is *not* stored here. It's a temporary value that only exists for the length of one upload — see Section 8.

**Also note:** "interested" isn't a field on the candidate either — it's tracked per candidate *per job order* (someone could be interested in one job and not another), so it lives as its own small table linking candidates to the job orders they marked interested in.

## 6. How the Magic Link Works

The link isn't tied to one single job — it's tied to a **category**. When a candidate opens their link, they see **every open job order in that category**, and they pick whichever one fits their own experience and skills — and can mark themselves **"interested"** right there on the page (see Section 4's Review Magic Blasts example for how that gets reported back). The recruiter doesn't have to guess or match candidates to individual jobs one by one — the candidate self-selects.

*Working assumption: only "Published" job orders show up on the link (see Section 11's Views/filters) — unpublished or completed ones are hidden. Flag if that's not right.*

## 7. Blast Guard (Cooldown Rule)

To avoid spamming the same person, a candidate can't receive another magic link until a set number of days has passed since their last one.

- **Default: 3 days**
- Should be adjustable (an admin setting), not hardcoded
- **Global, not per category:** one blast — regardless of which category it's for — resets the clock. Driven entirely by **Last Blast** (Section 5).

## 8. Selecting Candidates to Blast (by Last Contacted)

Sometimes a recruiter doesn't want to blast an entire uploaded list — just a slice of it, like "the 300 most recently contacted." Last Contacted isn't something we keep on file — it only exists for the length of that one upload:

1. Upload the list — the file can include a Last Contacted date per person
2. Sort everyone by Last Contacted, newest first (done in-memory on the upload itself, not a database lookup, since nothing's stored)
3. Take the requested number (e.g. 300)
4. **Blast Guard still applies on top of this** (Section 7) — anyone in that top 300 who's currently in cooldown gets skipped automatically
5. The recruiter sees a result count, e.g. *"287 sent, 13 skipped (cooldown)"*
6. Once the blast is sent, the Last Contacted values from that upload are **thrown away** — they're never written to the candidate record

## 9. The Overwrite Rule

When an imported list has a phone number we already have on file, but a **different name** attached to it:

- **Overwrite:** the name
- **Keep unchanged:** last blast, number of blasts

Everything else about that candidate's history stays intact. The phone number is what ties it all together (Primary Key); the magic link depends on it (Foreign Key).

## 10. Job Order Categories

Industrial, Administrative, Skilled Trade.
**Important:** this is a property of the *job order*, not the candidate — a candidate isn't locked to one category, since they self-select (Section 6).

## 11. Screens

- **Dashboard** — the views with filters live here: Publish / Unpublish / Complete / etc.
- **"Tom"** — the chat-style interface (see Sections 3 & 4)
- **Admin** — everything below lives here:
  - Settings
  - Feedback
  - Changelog/patch log
  - **Templates** for blast messages
  - **User management**
  - **Credential management for Whippy** *(the texting/SMS provider actually sending the Magic Blasts today — a known placeholder, since it's being replaced by an in-house platform called **Relay** soon; see Section 17)*
  - **Onboarding flow** — walks a new user through entering their Whippy credentials correctly

## 12. Importing Data

Both file types below originate from **Q4** (Express's source-of-truth system, Section 1) — recruiters export from there and bring the file into JobLink.

- **Job Orders** can be manually typed in, or imported from **.doc, .docx, or .txt** files
- **Magic Blast lists** can be manually typed in, or imported from **.csv** or various **Excel formats** — really just first name, last name, phone number, plus an optional Last Contacted date used only in the moment (Section 8), never stored (Section 5)
- **Parser edge case:** sometimes the name arrives as one combined column (e.g. "John Smith" in a single cell) instead of separate first/last columns. The parser needs to split that into first name and last name on its own.
- See Section 9 for what happens when an imported number already exists

## 13. What It Should Feel Like

Fast, intuitive, robust, guardrailed, consistent.

## 14. Explicitly NOT in Scope (for now)

- The Help/Tutorial/FAQ button never makes a real tool call — it can generate tailored, simulated walkthroughs, but nothing it shows is ever saved, sent, or published (see Section 4)
- Job order category is not a candidate field (see Section 10)
- Last Contacted is not stored data (see Section 5)

## 15. Nice-to-Haves (later, not core)

- **Zero data retention** — candidate/blast data isn't kept longer than necessary (privacy-first option)
- Nurture sequences (automatic multi-step follow-up)
- Matched Jobs (auto-suggesting jobs to candidates)
- Automated testing + QA

## 16. To Discuss Later (technical approach, not urgent)

- **Data migrations and AI-assisted matching** — still to be scoped once we pick the actual tech stack. Doesn't affect the features above.
- ~~"Shape-index" files~~ — clarified below (Section 17), not a lookup mechanism after all.

## 17. How We'll Build It

**Testing built in from day one.** Every feature we build gets a matching test or check, so we (and the AI helping build it) can verify something actually works — not just that it looks like it works. Because of Hybrid Vigor (Section 4), tests need to cover two different kinds of behavior: the deterministic parts (button paths, publish/unpublish, Blast Guard) get exact-match tests, while the AI-assisted parts (parsing a document into Job Order fields) need "did it get the right answer" checks rather than exact-text matches. The Blast Guard, Overwrite Rule (Sections 7 & 9), and the name-splitting parser (Section 12) are exactly the kind of logic that needs a test proving it behaves correctly every time. The Help/FAQ sandbox (Section 4) needs its own kind of test too — proving it *never* writes to the real database, sends a real text, or publishes a real job order, no matter what's asked of it.

**A "shape" file for every repo.** Alongside tests, each repo gets a written guide that tells any AI assistant working in it what the codebase does, how it's organized, and how to safely interact with it — a map, not just a checklist. Tests confirm the code works; the shape file makes sure the AI building or maintaining it actually understands what it's looking at.

**Clarify → Delete → Optimize → Accelerate → Automate.** Before building anything, we pin down exactly what's required. Then we cut anything not essential (see Section 14) — Last Contacted not needing storage (Section 5) is a good example of deleting before optimizing. Only after that do we make it faster or automate it.

**Keep the messaging piece swappable.** Since Whippy is already a known placeholder and Relay is planned to replace it (Section 1), the messaging integration should sit behind a clean boundary — so that swap, when it happens, doesn't mean touching how Job Orders, Magic Blasts, or Blast Guard work at all.

**Steady pace, not sprints.** We build in small, consistent, dependable steps rather than rushing — this keeps quality high and avoids burnout or rework.

**Safety margins built in.** Data backups and safeguards are in place *before* we need them, not after something breaks. The Send Magic Blast flow's button-press confirmation (Section 4) is a good example — a harder-to-undo action (texting real people) gets a harder gate than a reversible one (saving a draft job order).

**Small tests before big commitments.** We try a small version of a risky feature first (a "bullet") to see if it works, before committing to the full build (the "cannonball"). This keeps costs low if something needs to change.

## 18. Porting from JobLink V1

This brief — and the fresh V2.0 repo built from it — is the **master template** going forward. The existing V1 repo (`/home/user/joblink`) isn't the base; it's a source to excavate for real, working logic worth bringing over rather than rebuilding from scratch.

Known items to bring in so far:

- **Closing Whippy conversations** — sending a Magic Blast opens a conversation thread in Whippy. There needs to be a way to close it back out.
- **Assigning candidates to recruiters** — some notion of ownership isn't reflected yet in the Candidate Record (Section 5) or Job Order data, and needs to be added once pulled from V1.

This list is expected to grow as V1 gets reviewed — treat it as living, not final.
