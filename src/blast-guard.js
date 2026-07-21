// Blast Guard — the cooldown rule. One of the rules that must NEVER be
// silently broken (SHAPE.md). Pure functions: no database, no clock of its
// own — everything is passed in, so tests are exact.
//
// Rules:
//  - A candidate cannot receive a new magic link until COOLDOWN_HOURS have
//    passed since their last_blast. Default 72 hours ("3 days" is defined as
//    exactly 72 hours — see docs/DECISIONS.md).
//  - Global, not per-category: any blast resets the clock.
//  - do_not_contact (STOP replies) is an infinite cooldown. Nothing overrides it.

const DEFAULT_COOLDOWN_HOURS = 72;

/**
 * Decide whether one candidate may be blasted right now.
 * @param {object} candidate  { last_blast: ISO string|null, do_not_contact: 0|1 }
 * @param {Date}   now
 * @param {number} cooldownHours
 * @returns {{ allowed: boolean, reason: 'ok'|'do_not_contact'|'cooldown' }}
 */
function checkBlastGuard(candidate, now = new Date(), cooldownHours = DEFAULT_COOLDOWN_HOURS) {
  if (candidate.do_not_contact) return { allowed: false, reason: 'do_not_contact' };
  if (!candidate.last_blast) return { allowed: true, reason: 'ok' };
  const last = new Date(candidate.last_blast);
  const hoursSince = (now.getTime() - last.getTime()) / 36e5;
  if (hoursSince < cooldownHours) return { allowed: false, reason: 'cooldown' };
  return { allowed: true, reason: 'ok' };
}

/**
 * Partition a list of candidates into sendable vs skipped.
 * This runs BEFORE the preview is shown (docs/DECISIONS.md) so the recruiter
 * confirms what will actually happen.
 */
function applyBlastGuard(candidates, now = new Date(), cooldownHours = DEFAULT_COOLDOWN_HOURS) {
  const sendable = [];
  const skipped = [];
  for (const c of candidates) {
    const verdict = checkBlastGuard(c, now, cooldownHours);
    if (verdict.allowed) sendable.push(c);
    else skipped.push({ ...c, skip_reason: verdict.reason });
  }
  return { sendable, skipped };
}

module.exports = { checkBlastGuard, applyBlastGuard, DEFAULT_COOLDOWN_HOURS };
