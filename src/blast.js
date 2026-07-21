// Blast engine — plan (guard-first preview) then execute (paced, partial-send safe).
//
// Order of operations (docs/DECISIONS.md):
//   parse upload → upsert (Overwrite Rule) → ephemeral Last Contacted subset
//   → BLAST GUARD → preview shows real counts → button-press confirm → send.
//
// Partial-send rule: last_blast / blast_count / current_category update ONLY
// for candidates whose message was actually accepted by the provider. A failed
// send never burns a cooldown.

const { applyBlastGuard } = require('./blast-guard');
const { getCooldownHours, getSetting } = require('./db');

const SMS_RATE_LIMIT_MS = 100; // 10 sends/sec — ported from V1 (Whippy pacing)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CATEGORIES = ['Industrial', 'Administrative', 'Skilled Trade'];

/** Render a template for one candidate. Placeholders: {first_name}, {link}. */
function renderMessage(templateBody, candidate, baseUrl) {
  const link = `${baseUrl}/m/${candidate.magic_token}`;
  return String(templateBody)
    .replace(/\{first_name\}/g, candidate.first_name || 'there')
    .replace(/\{link\}/g, link);
}

/**
 * Build a blast plan: given selected phones (already upserted + subset-selected),
 * apply Blast Guard and return everything the preview needs.
 */
function planBlast(db, { phones, category, now = new Date() }) {
  if (!CATEGORIES.includes(category)) throw new Error(`Invalid category: ${category}`);
  const cooldownHours = getCooldownHours(db);
  const get = db.prepare('SELECT * FROM candidates WHERE phone = ?');
  const candidates = phones.map((p) => get.get(p)).filter(Boolean);
  const { sendable, skipped } = applyBlastGuard(candidates, now, cooldownHours);
  return {
    category,
    cooldownHours,
    sendable,
    skippedCooldown: skipped.filter((s) => s.skip_reason === 'cooldown'),
    skippedDnc: skipped.filter((s) => s.skip_reason === 'do_not_contact'),
  };
}

/**
 * Execute a confirmed plan. Creates the Blast record, sends with pacing,
 * applies the partial-send rule, and returns final counts.
 */
async function executeBlast(db, plan, { templateId, templateBody, provider, sentBy = null, now = new Date(), pacingMs = SMS_RATE_LIMIT_MS }) {
  if (!templateBody.includes('{link}')) throw new Error('Template must include {link}'); // V1 rule
  const baseUrl = getSetting(db, 'base_url') || 'http://localhost:3000';

  const insertBlast = db.prepare(
    `INSERT INTO blasts (category, template_id, message_preview, skipped_cooldown_count, skipped_dnc_count, sent_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const blastId = Number(insertBlast.run(
    plan.category, templateId ?? null, templateBody,
    plan.skippedCooldown.length, plan.skippedDnc.length, sentBy,
  ).lastInsertRowid);

  const recRecipient = db.prepare(
    'INSERT OR REPLACE INTO blast_recipients (blast_id, phone, status, error) VALUES (?, ?, ?, ?)',
  );
  for (const s of plan.skippedCooldown) recRecipient.run(blastId, s.phone, 'skipped_cooldown', null);
  for (const s of plan.skippedDnc) recRecipient.run(blastId, s.phone, 'skipped_dnc', null);

  const markSent = db.prepare(
    `UPDATE candidates SET last_blast = ?, blast_count = blast_count + 1, current_category = ? WHERE phone = ?`,
  );

  let sent = 0, failed = 0;
  for (const c of plan.sendable) {
    const body = renderMessage(templateBody, c, baseUrl);
    const result = await provider.sendSms({ to: c.phone, body });
    if (result.ok) {
      // Partial-send rule: only an ACCEPTED send burns the cooldown
      markSent.run(now.toISOString(), plan.category, c.phone);
      recRecipient.run(blastId, c.phone, 'sent', null);
      sent++;
    } else {
      recRecipient.run(blastId, c.phone, 'failed', result.error || 'send failed');
      failed++;
    }
    if (pacingMs > 0) await sleep(pacingMs);
  }

  db.prepare('UPDATE blasts SET sent_count = ?, failed_count = ? WHERE id = ?').run(sent, failed, blastId);

  // Extension point (PORTING_FROM_V1): close the conversation threads the blast opened
  let conversationsClosed = 0;
  if (typeof provider.closeOpenConversations === 'function') {
    try { conversationsClosed = (await provider.closeOpenConversations()).closed || 0; } catch { /* best-effort */ }
  }

  return {
    blastId,
    sent,
    failed,
    skippedCooldown: plan.skippedCooldown.length,
    skippedDnc: plan.skippedDnc.length,
    conversationsClosed,
  };
}

/** Review Magic Blasts: recent blasts with interested-reply counts. */
function listBlasts(db, limit = 20) {
  return db.prepare(
    `SELECT b.*, (SELECT COUNT(*) FROM interests i WHERE i.blast_id = b.id) AS interested_count
     FROM blasts b ORDER BY b.id DESC LIMIT ?`,
  ).all(limit);
}

/** Mark a candidate do-not-contact (STOP reply / manual). Infinite cooldown. */
function markDoNotContact(db, phone, value = true) {
  db.prepare('UPDATE candidates SET do_not_contact = ? WHERE phone = ?').run(value ? 1 : 0, phone);
}

module.exports = { planBlast, executeBlast, renderMessage, listBlasts, markDoNotContact, CATEGORIES, SMS_RATE_LIMIT_MS };
