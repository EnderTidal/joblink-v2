// Blast engine — plan (guard-first preview) then execute (paced, partial-send safe).
//
// Order of operations (docs/DECISIONS.md):
//   parse upload → upsert (Overwrite Rule) → ephemeral Last Contacted subset
//   → BLAST GUARD → preview shows real counts → button-press confirm → send.
//
// Partial-send rule: last_blast / blast_count / current_category update ONLY
// for candidates whose message was actually accepted by the provider. A failed
// send never burns a cooldown.
//
// V2.1: recruiter assignment — executeBlast accepts recruiterId/recruiterUsername,
// stores in blast record for downstream Whippy conversation assignment.

const { applyBlastGuard } = require('./blast-guard');
const { getCooldownHours, getSetting } = require('./db');

const SMS_RATE_LIMIT_MS = 100; // 10 sends/sec — ported from V1 (Whippy pacing)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_CATEGORIES = ['Industrial', 'Administrative', 'Skilled Trade'];

/** Read categories from the DB, falling back to defaults if the table doesn't exist. */
function getCategories(db) {
  const cats = new Set(DEFAULT_CATEGORIES);
  try {
    const rows = db.prepare('SELECT name FROM categories ORDER BY sort_order, id').all();
    rows.forEach(r => cats.add(r.name));
  } catch { /* table doesn't exist yet */ }
  try {
    const candCats = db.prepare('SELECT DISTINCT current_category FROM candidates WHERE current_category IS NOT NULL AND length(current_category) > 0').all();
    candCats.forEach(r => cats.add(r.current_category));
  } catch {}
  return [...cats];
}

// Legacy compat: const CATEGORIES still exported as the defaults
const CATEGORIES = DEFAULT_CATEGORIES;

/** Get or create a blast-specific token for a candidate+category. */
function getBlastToken(db, phone, category, blastId) {
  // Check for existing token for this phone+category
  const existing = db.prepare('SELECT token FROM blast_tokens WHERE phone = ? AND category = ?').get(phone, category);
  if (existing) return existing.token;
  // Create new token
  const token = require('crypto').randomBytes(16).toString('base64url');
  db.prepare('INSERT INTO blast_tokens (phone, category, token, blast_id) VALUES (?, ?, ?, ?)').run(phone, category, token, blastId);
  return token;
}

/** Render a template for one candidate. Placeholders: {first_name}, {link}. */
function renderMessage(templateBody, candidate, baseUrl, orgSlug, categorySlug, blastToken) {
  const token = blastToken || candidate.magic_token;
  const link = orgSlug && categorySlug
    ? `${baseUrl}/m/${orgSlug}/${categorySlug}/${token}`
    : orgSlug
    ? `${baseUrl}/m/${orgSlug}/${token}`
    : `${baseUrl}/m/${token}`;
  return String(templateBody)
    .replace(/\{first_name\}/g, candidate.first_name || 'there')
    .replace(/\{link\}/g, link);
}

/**
 * Build a blast plan: given selected phones (already upserted + subset-selected),
 * apply Blast Guard and return everything the preview needs.
 */
function planBlast(db, { phones, category, now = new Date(), skipBlastGuard = false }) {
  const validCats = getCategories(db);
  if (!validCats.some(c => c.toLowerCase() === category.toLowerCase())) throw new Error(`Invalid category: ${category}`);
  const cooldownHours = getCooldownHours(db);
  const get = db.prepare('SELECT * FROM candidates WHERE phone = ?');
  const candidates = phones.map((p) => get.get(p)).filter(Boolean);
  const { sendable, skipped } = skipBlastGuard
    ? { sendable: candidates.filter(c => !c.do_not_contact), skipped: candidates.filter(c => c.do_not_contact).map(c => ({ ...c, skip_reason: 'do_not_contact' })) }
    : applyBlastGuard(candidates, now, cooldownHours);
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
 *
 * V2.1: accepts recruiterId and recruiterUsername for Whippy conversation assignment.
 */
async function executeBlast(db, plan, { templateId, templateBody, provider, sentBy = null, now = new Date(), pacingMs = SMS_RATE_LIMIT_MS, baseUrl: baseUrlOverride, orgSlug = null, recruiterId = null, recruiterUsername = null }) {
  if (!templateBody.includes('{link}')) throw new Error('Template must include {link}'); // V1 rule
  const baseUrl = baseUrlOverride || getSetting(db, 'base_url') || 'http://localhost:3000';

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
  for (const phone of (plan.skippedExclusion || [])) recRecipient.run(blastId, phone, 'skipped_exclusion', null);

  // FIX 4: use SQLite strftime for last_blast timestamp (DB clock, not app clock)
  // SET_CATEGORY_IF_NULL: set candidate category from blast category if currently empty
    const setCategory = db.prepare("UPDATE candidates SET current_category = ? WHERE phone = ?");
    const markSent = db.prepare(
    `UPDATE candidates SET last_blast = strftime('%Y-%m-%dT%H:%M:%fZ','now'), blast_count = blast_count + 1 WHERE phone = ?`,
  );

  // Snapshot open conversations BEFORE blast (only close NEW ones after)
  let preBlastConvoIds = new Set();
  if (typeof provider.getOpenConversationIds === 'function') {
    try { preBlastConvoIds = new Set(await provider.getOpenConversationIds()); } catch(e) {}
  }

  // Sync contacts to Whippy before sending — ensures names show in Whippy inbox
  if (typeof provider.ensureContact === 'function') {
    console.log('[blast] Syncing ' + plan.sendable.length + ' contacts to Whippy...');
    let synced = 0, skipped = 0, errors = 0;
    for (const c of plan.sendable) {
      const r = await provider.ensureContact(c.phone, c.first_name, c.last_name);
      if (r.ok) { if (r.action === 'created' || r.action === 'updated') synced++; else skipped++; }
      else errors++;
      if (pacingMs > 0) await sleep(Math.floor(pacingMs / 2)); // half-pace for lookups
    }
    console.log('[blast] Contact sync done: ' + synced + ' synced, ' + skipped + ' already good, ' + errors + ' errors');
  }

  let sent = 0, failed = 0;
  for (const c of plan.sendable) {
    const body = renderMessage(templateBody, c, baseUrl, orgSlug);
    const result = await provider.sendSms({ to: c.phone, body });
    if (result.ok) {
      // Partial-send rule: only an ACCEPTED send burns the cooldown
      markSent.run(c.phone);
        setCategory.run(plan.category, c.phone);
      recRecipient.run(blastId, c.phone, 'sent', null);
      sent++;
      // Always close conversation immediately after send — prevents AI agents from grabbing it
      if (result.conversationId && typeof provider._patchConversation === 'function') {
        try {
          const patchBody = { status: 'closed' };
          if (recruiterId) patchBody.assigned_user_id = Number(recruiterId);
          await provider._patchConversation(result.conversationId, patchBody);
        } catch(e) { console.error('[blast] inline close failed:', e.message); }
      }
    } else {
      recRecipient.run(blastId, c.phone, 'failed', result.error || 'send failed');
      failed++;
    }
    if (pacingMs > 0) await sleep(pacingMs);
  }

  db.prepare('UPDATE blasts SET sent_count = ?, failed_count = ? WHERE id = ?').run(sent, failed, blastId);

  // Extension point (PORTING_FROM_V1): close the conversation threads the blast opened
  let conversationsClosed = 0;
  if (typeof provider.assignAndCloseNewConversations === 'function') {
    console.log('[blast] Calling assignAndCloseNewConversations with recruiterId:', recruiterId, 'preBlastConvoIds count:', preBlastConvoIds.size);
    try { const r = await provider.assignAndCloseNewConversations(recruiterId || null, preBlastConvoIds); console.log('[blast] assignAndClose result:', JSON.stringify(r)); conversationsClosed = r.closed || 0; } catch(e) { console.error('[blast] assignAndClose ERROR:', e.message); }
  } else if (typeof provider.closeOpenConversations === 'function') {
    try { conversationsClosed = (await provider.closeOpenConversations()).closed || 0; } catch { /* best-effort */ }
  }

  return {
    blastId,
    sent,
    failed,
    skippedCooldown: plan.skippedCooldown.length,
    skippedDnc: plan.skippedDnc.length,
    skippedExclusion: (plan.skippedExclusion || []).length,
    conversationsClosed,
    recruiterId,
    recruiterUsername,
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

module.exports = { planBlast, executeBlast, getBlastToken, renderMessage, listBlasts, markDoNotContact, CATEGORIES, getCategories, SMS_RATE_LIMIT_MS };
