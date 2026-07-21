# JobLink V2.0 — Spec Review

*Review of the Drive folder docs (PROJECT_BRIEF.md, FABLE_BUILD_PROMPT.md, DECISIONS.md, SHAPE.md, README.md, PORTING_FROM_V1.md, CHANGELOG.md) — July 21, 2026*

## Overall verdict

This is a strong, unusually disciplined spec. The north star ("just a DB and a parser"), the decisions log, the two-flavor testing philosophy, the swappable messaging boundary, and confirmation gates that scale with how reversible an action is — all of that is exactly right and rare to see written down before code exists.

That said, I found **one hole in the data model that would break a core feature**, a couple of undefined relationships, and a few risks worth deciding on before anyone builds. None of them are hard to fix now. All of them are expensive to fix later.

---

## The big one: there's no "Blast" record in the data model

The data model has three things: Candidate, Job Order, and Interest. But the **Review Magic Blasts** path promises to show "recent blast activity: number sent, number of interested replies" — per blast.

You can't report on blasts if blasts aren't stored anywhere. The candidate record only remembers *their own* last blast date and a count. There's no record that says "on July 20, we sent an Industrial blast to 287 people using Template X, and 34 of them marked interested."

**Fix:** add a fourth table — **Blast** — recording when it went out, which category, which template, how many sent, how many skipped by cooldown, and (eventually) which recruiter sent it. The Interest table should also note which blast brought the candidate in, so "interested replies per blast" is countable. This also quietly solves the recruiter-attribution gap already flagged in PORTING_FROM_V1.

## Second: the magic link ↔ category relationship is undefined

Each candidate has **one** magic link, permanently tied to their phone number. But the link shows jobs in **one category**. So: a candidate gets an Industrial blast this week, then an Administrative blast next month. What does their link show now?

The spec never says. Options, roughly:

- The link's category updates to whatever the most recent blast was (simplest, probably right)
- Each blast generates a fresh link (contradicts "one link per candidate")
- The link shows all categories (contradicts "tied to a category")

**Fix:** pick one, log it in DECISIONS.md. If it's the first option, the category effectively lives on the *blast*, and the link just points at the candidate's most recent blast's category — which is another reason the Blast table needs to exist.

## Third: phone numbers need a normalization rule

Phone number is the primary key — everything hangs on it. But "(555) 123-4567", "555-123-4567", and "+15551234567" are the same person in three different costumes. Without one strict rule for cleaning numbers before matching, the same candidate becomes three records, and **Blast Guard silently fails** — the one rule the docs say must never be silently broken.

**Fix:** one line in the spec ("all numbers stored as digits-only, 10-digit US format" or E.164), plus a deterministic test with the messy variants. This is exactly a Steinberger-style test: feed it every format, demand one canonical output, every time.

## Fourth: the Job Order fields are never listed

The brief keeps saying "the Job Order template fields," and the build prompt says "standard job order fields (title, description, etc.)" — but nowhere is the actual list. The parser needs it, the eval-style tests need it, and the candidate-facing job board needs it (your project description mentions pay, requirements, hours — none of which appear in the spec).

**Fix:** enumerate the fields once — title, category, pay, shift/hours, location, requirements, description, status — and mark which are required for publishing. Without this, whoever builds it will invent the list, and the eval tests have nothing to grade against.

## Fifth: SMS compliance — opt-out isn't handled

Mass-texting people has legal rules (TCPA in the US). Blast Guard prevents *annoying* people, but nothing in the spec handles someone who says **stop texting me**. If a candidate replies STOP, Whippy likely suppresses future sends on its side — but JobLink would keep counting them as blastable, and the Relay swap could lose that suppression list entirely.

**Fix:** add a `do_not_contact` flag on the Candidate record that Blast Guard treats as an infinite cooldown, and decide how it gets set. Also consider quiet hours (no 3am texts). *I'm not a lawyer — worth a real compliance check before high-volume sending.*

---

## Smaller things worth a decision

**Blast Guard's position in the send flow is ambiguous.** The build prompt's flow shows: preview → button press → *then* Blast Guard skips people. Better: apply Blast Guard *before* the preview, so the recruiter confirms what will actually happen ("287 will be sent, 13 skipped") rather than finding out after pressing the button.

**"3 days" needs a precise definition.** Is it 72 hours, or "3 calendar days"? Exact-match tests can't be written against a fuzzy word. Recommend 72 hours from the `last_blast` timestamp — simplest to test.

**Partial-send failure isn't specified.** If Whippy dies after 150 of 300 texts, what happens? Recommend one rule: `last_blast` and `blast_count` update only for candidates whose message was actually accepted for sending, and the blast record shows sent/failed counts. Otherwise a failed blast burns 300 people's cooldowns for texts they never got.

**Template selection is missing from the blast flow.** Admin has message templates, but the Send Magic Blast steps never include picking one. Add a step (or a default-template rule).

**Publishing later is implied but not specified.** A job order can "stay unpublished" — but the only stated way to publish is inside the New Job Order chat. The Dashboard has filters, not actions. One sentence ("Dashboard rows have publish/unpublish/complete actions") closes it.

**Magic link URLs must be unguessable.** If links are predictable, anyone could enumerate them and mark interest as someone else. Use a random token, not anything derived from the phone number.

**One-pass build vs. bullets-before-cannonballs.** The build prompt says "build it in one pass," but Section 16 of the same document preaches small tests before big commitments. These pull against each other. Suggestion: treat the one-pass build *as* the bullet — a working end-to-end slice — but stage it (data model + Blast Guard tests first, then the Tom paths, then the candidate page) so each layer proves itself before the next. Same destination, but you'd catch a data-model problem like the missing Blast table at hour two instead of hour twenty.

---

## What's already excellent (don't touch)

The ephemeral Last Contacted rule is a textbook "delete before optimizing" call. The Help/FAQ sandbox with a test proving it can never touch real data is a genuinely good safety design. The Overwrite Rule is crisp and testable. The swappable messaging boundary is the right hedge on Whippy→Relay. And SHAPE.md's "rules that must never be silently broken" list is exactly the kind of thing that keeps AI builders honest.

## Recommended order of operations

1. Add the Blast table + decide the link↔category rule (unblocks Review Magic Blasts and recruiter attribution)
2. Write the phone normalization rule and the Job Order field list into the brief
3. Decide the five smaller items above; append each to DECISIONS.md
4. Add `do_not_contact` to the data model; get a quick compliance sanity check
5. *Then* pick the tech stack and start the staged build

Each of these is a spec edit, not code. Half a day of decisions now saves the rebuild later.
