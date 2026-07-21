// "Tom" — the chat interface. Not a person; a deterministic state machine
// with AI assistance inside each path (Hybrid Vigor, PROJECT_BRIEF §4).
//
// Four fixed paths, one per conversation. Picking a button commits the
// session to that path; switching paths = a new conversation. Inside a path,
// the AI handles the flexible part (parsing uploads/free text) — the flow
// itself never varies.
//
// Confirmation gates scale with reversibility:
//   - New Job Order: typed "publish" is enough (a draft is easy to undo)
//   - Send Magic Blast: ONLY the button action 'confirm_send' sends.
//     A typed "yes" is explicitly rejected (see BLAST_CONFIRM_REJECTION).

const crypto = require('node:crypto');
const { parseContactRows, parseContactFile, upsertCandidates, selectByLastContacted } = require('./importing');
const { normalizePhone } = require('./phone');
const { splitName } = require('./names');
const { planBlast, executeBlast, listBlasts, renderMessage, CATEGORIES } = require('./blast');
const { JOB_ORDER_FIELDS, validateJobOrder, createJobOrder } = require('./job-orders');
const { parseJobOrderText, extractText } = require('./ai/parse-job-order');
const { answerHelpQuestion } = require('./ai/help-faq');
const { getProvider } = require('./messaging');
const { getSetting } = require('./db');

const PATHS = ['job_order', 'blast', 'review', 'help'];
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

const BLAST_CONFIRM_REJECTION =
  'For safety, sending requires pressing the Send button — a typed "yes" isn\'t enough. ' +
  'Real texts to real people get the strongest gate we have.';

const JOB_ORDER_EXAMPLE =
  'Type the details like this, or upload a .docx/.txt file:\n\n' +
  'Title: Forklift Operator\nCategory: Industrial\nPay: $18/hr\n' +
  'Shift: 1st shift, 6am-2:30pm\nLocation: Waxahachie, TX\n' +
  'Requirements: 6+ months forklift experience\nDescription: Move palletized goods in a climate-controlled warehouse.';

function draftSummary(draft) {
  const lines = JOB_ORDER_FIELDS.map((f) => `${f.label}: ${draft[f.key] || '—'}`);
  const v = validateJobOrder(draft);
  if (!v.ok) {
    lines.push('');
    if (v.missing.length) lines.push(`⚠ Missing required: ${v.missing.join(', ')}`);
    v.errors.forEach((e) => lines.push(`⚠ ${e}`));
  }
  return lines.join('\n');
}

// Deterministic field-edit command parsing: "set pay to $18.50", "pay: $18.50",
// "location should be Ennis TX", "change title to Welder"
const FIELD_KEYS = {
  title: 'title', category: 'category', pay: 'pay', wage: 'pay', salary: 'pay',
  shift: 'shift_hours', hours: 'shift_hours', schedule: 'shift_hours', 'shift/hours': 'shift_hours',
  location: 'location', city: 'location', requirements: 'requirements', description: 'description', company: 'company',
  status: 'status',
};
function parseFieldEdit(text) {
  const m = String(text).trim().match(
    /^(?:set\s+|change\s+|update\s+|the\s+)?([a-z/ ]+?)\s*(?:to\s+|should\s+be\s+|is\s+|=\s*|:\s*)(.+)$/i,
  );
  if (!m) return null;
  const key = FIELD_KEYS[m[1].trim().toLowerCase()];
  if (!key) return null;
  return { field: key, value: m[2].trim() };
}

// Manual contact entry: one contact per line — "John Smith 555-123-4567" / "Smith, John, 5551234567"
function parseManualContacts(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const phoneMatch = line.match(/(\+?1?[\s.\-(]*\d{3}[\s.\-)]*\d{3}[\s.\-]*\d{4})\s*$/);
    if (!phoneMatch) { rows.push([line.trim(), '']); continue; }
    const name = line.slice(0, phoneMatch.index).replace(/[,;]\s*$/, '').trim();
    rows.push([name, phoneMatch[1]]);
  }
  return parseContactRows(rows.map(([name, phone]) => [name, phone]));
}

function createTom(db) {
  const sessions = new Map();

  function newSession(path, user) {
    if (!PATHS.includes(path)) throw new Error('Unknown path');
    const id = crypto.randomBytes(12).toString('base64url');
    const s = { id, path, user: user || null, state: 'start', data: {}, createdAt: Date.now() };
    sessions.set(id, s);
    // TTL sweep
    for (const [k, v] of sessions) if (Date.now() - v.createdAt > SESSION_TTL_MS) sessions.delete(k);
    return s;
  }

  function reply(session, text, extra = {}) {
    return { sessionId: session.id, path: session.path, state: session.state, text, ...extra };
  }

  // ---------- path: job_order ----------
  async function startJobOrder(s) {
    s.state = 'await_input';
    return reply(s, `Let's create a Job Order. ${JOB_ORDER_EXAMPLE}`);
  }

  async function handleJobOrder(s, { text, action, payload, file }) {
    if (s.state === 'await_input') {
      let docText = text || '';
      if (file) docText = await extractText(file.buffer, file.originalname);
      if (!docText.trim()) return reply(s, 'Type the job details or upload a .docx/.txt file to get started.');
      const parsed = await parseJobOrderText(docText);
      if (!parsed.fields) return reply(s, 'That document looks empty — try again?');
      s.data.draft = parsed.fields;
      s.state = 'review';
      const warn = parsed.warnings.length ? `\n\n(Notes: ${parsed.warnings.join('; ')})` : '';
      return reply(s, `Here's what I read:\n\n${draftSummary(s.data.draft)}${warn}\n\n` +
        'Fix anything by typing (e.g. "set pay to $18.50") or editing a field directly. ' +
        'Say "publish" to put it on the job board, or "done" to save it unpublished.',
        { draft: s.data.draft, fields: JOB_ORDER_FIELDS });
    }

    if (s.state === 'review') {
      const draft = s.data.draft;
      if (action === 'edit_field' && payload?.field) {
        draft[payload.field] = String(payload.value ?? '').trim();
        return reply(s, `Updated.\n\n${draftSummary(draft)}`, { draft });
      }
      const t = String(text || '').trim();
      if (/\b(publish|go live|publish it|ship it|looks good|good to go|make it live)\b/i.test(t)) {
        draft.status = 'Published';
        const v = validateJobOrder(draft);
        if (!v.ok) return reply(s, `Can't publish yet — ${[...v.missing.map((m) => `missing ${m}`), ...v.errors].join('; ')}.\n\n${draftSummary(draft)}`, { draft });
        const id = createJobOrder(db, draft);
        s.state = 'ask_another';
        return reply(s, `✅ Published job order #${id}: ${draft.title} (${draft.category}). It's live on the job board now.\n\nWant to create another? (yes / no)`);
      }
      if (/\b(done|save|keep it|finish|save it)\b/i.test(t)) {
        draft.status = draft.status === 'Published' ? 'Published' : 'Unpublished';
        const v = validateJobOrder(draft);
        if (!v.ok) return reply(s, `Almost — ${[...v.missing.map((m) => `missing ${m}`), ...v.errors].join('; ')}.\n\n${draftSummary(draft)}`, { draft });
        const id = createJobOrder(db, draft);
        s.state = 'ask_another';
        return reply(s, `💾 Saved job order #${id}: ${draft.title} (${draft.status}). You can publish it later from the Dashboard.\n\nWant to create another? (yes / no)`);
      }
      const edit = parseFieldEdit(t);
      if (edit) {
        if (edit.field === 'category') {
          const cat = CATEGORIES.find((c) => c.toLowerCase() === edit.value.toLowerCase().replace(/s$/, ''))
            || CATEGORIES.find((c) => edit.value.toLowerCase().includes(c.toLowerCase()));
          if (!cat) return reply(s, `Category has to be one of: ${CATEGORIES.join(', ')}.`, { draft });
          draft.category = cat;
        } else if (edit.field === 'status') {
          return reply(s, 'Say "publish" to publish, or "done" to save unpublished — status changes go through those.', { draft });
        } else {
          draft[edit.field] = edit.value;
        }
        return reply(s, `Updated.\n\n${draftSummary(draft)}`, { draft });
      }
      return reply(s, 'I can update a field ("set pay to $18.50"), or you can say "publish" or "done".', { draft });
    }

    if (s.state === 'ask_another') {
      if (/^y/i.test(String(text || ''))) { s.data = {}; return startJobOrder(s); }
      s.state = 'ended';
      return reply(s, 'All set. Start a new conversation any time you need another job order.');
    }
    return reply(s, 'This conversation has ended — start a new one from the buttons above.');
  }

  // ---------- path: blast ----------
  async function startBlast(s) {
    s.state = 'await_contacts';
    return reply(s,
      'Let\'s send a Magic Blast. Upload a contact list (.csv or Excel), or type contacts one per line like:\n\n' +
      'John Smith 555-123-4567\nJane Doe (555) 987-6543');
  }

  async function handleBlast(s, { text, action, payload, file, user, reqHost, reqProto }) {
    if (s.state === 'await_contacts') {
      let parsed;
      if (file) parsed = parseContactFile(file.buffer, file.originalname);
      else if (String(text || '').trim()) parsed = parseManualContacts(text);
      else return reply(s, 'Upload a contact list or type contacts to get started.');
      if (!parsed.contacts.length) {
        return reply(s, `I couldn't find any valid phone numbers in that${parsed.invalid.length ? ` (${parsed.invalid.length} rows had unusable numbers)` : ''}. Try again?`);
      }
      const counts = upsertCandidates(db, parsed.contacts);
      s.data.contacts = parsed.contacts;
      s.data.selection = parsed.contacts;
      const hasLC = parsed.contacts.some((c) => c.lastContacted);
      const invalidNote = parsed.invalid.length ? ` ${parsed.invalid.length} rows had bad phone numbers and were set aside.` : '';
      const importNote = `${counts.created} new, ${counts.updated} name-updated, ${counts.unchanged} already on file.`;
      if (hasLC) {
        s.state = 'await_subset';
        return reply(s, `Got ${parsed.contacts.length} contacts (${importNote})${invalidNote}\n\n` +
          'This list has Last Contacted dates. Blast everyone, or a subset? ' +
          'Type a number (e.g. "300") for the most recently contacted, or "all". ' +
          '(These dates are used once for this selection, then discarded — never stored.)');
      }
      s.state = 'await_category';
      return reply(s, `Got ${parsed.contacts.length} contacts (${importNote})${invalidNote}\n\nWhich category is this blast for? This can't be skipped.`,
        { choices: CATEGORIES, choiceAction: 'choose_category' });
    }

    if (s.state === 'await_subset') {
      const t = String(text || '').trim().toLowerCase();
      if (/^all\b/.test(t)) s.data.selection = s.data.contacts;
      else {
        const n = parseInt(t.replace(/\D/g, ''), 10);
        if (!n || n < 1) return reply(s, 'Type a number (like "300") or "all".');
        s.data.selection = selectByLastContacted(s.data.contacts, n);
      }
      s.state = 'await_category';
      return reply(s, `Selected ${s.data.selection.length} contacts.\n\nWhich category is this blast for? This can't be skipped.`,
        { choices: CATEGORIES, choiceAction: 'choose_category' });
    }

    if (s.state === 'await_category') {
      let category = null;
      if (action === 'choose_category') category = payload?.category;
      else {
        const t = String(text || '').trim().toLowerCase();
        category = CATEGORIES.find((c) => c.toLowerCase() === t || t === c.toLowerCase().replace(' ', ''));
      }
      if (!CATEGORIES.includes(category)) {
        return reply(s, `I need a positive confirmation of the category — pick one: ${CATEGORIES.join(', ')}.`,
          { choices: CATEGORIES, choiceAction: 'choose_category' });
      }
      s.data.category = category;
      // Blast Guard BEFORE the preview (docs/DECISIONS.md) — recruiter confirms reality
      const plan = planBlast(db, { phones: s.data.selection.map((c) => c.phone), category });
      s.data.plan = plan;
      const templates = db.prepare('SELECT * FROM templates ORDER BY is_default DESC, id').all();
      // Category-specific default > global default > first template
      const catDefault = templates.find(t => t.is_default && t.category === category);
      const globalDefault = templates.find(t => t.is_default && (!t.category || t.category === ''));
      s.data.template = catDefault || globalDefault || templates[0];
      s.state = 'preview';
      const sample = plan.sendable[0]
        ? renderMessage(s.data.template.body, plan.sendable[0], getSetting(db, 'base_url') || '')
        : '(no sendable recipients)';
      const skippedBits = [];
      if (plan.skippedCooldown.length) skippedBits.push(`${plan.skippedCooldown.length} skipped (cooldown)`);
      if (plan.skippedDnc.length) skippedBits.push(`${plan.skippedDnc.length} skipped (do not contact)`);
      return reply(s,
        `Blast preview — ${category}\n` +
        `Template: ${s.data.template.name}\n` +
        `Sample message: "${sample}"\n\n` +
        `${plan.sendable.length} will be sent${skippedBits.length ? ', ' + skippedBits.join(', ') : ''}.\n\n` +
        'Press the Send button to send. (Typing "yes" won\'t send it — the button is the gate.)',
        {
          confirmButton: { action: 'confirm_send', label: `Send to ${plan.sendable.length} people` },
          templates: templates.map((t) => ({ id: t.id, name: t.name })),
          plan: { sendable: plan.sendable.map(c => ({ first_name: c.first_name, last_name: c.last_name, phone: c.phone })) },
        });
    }

    if (s.state === 'preview') {
      if (action === 'choose_template' && payload?.id) {
        const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(payload.id));
        if (t) { s.data.template = t; return reply(s, `Template switched to "${t.name}". Press Send when ready.`); }
      }
      if (action === 'confirm_send') {
        if (!s.data.plan.sendable.length) return reply(s, 'Nobody to send to — everyone was skipped.');
        s.state = 'sending';
        const provider = getProvider(db);
        const autoBaseUrl = reqHost ? ((reqProto === 'http' && reqHost.includes('localhost')) ? `http://${reqHost}` : `https://${reqHost}`) : undefined;
        const result = await executeBlast(db, s.data.plan, {
          templateId: s.data.template.id,
          templateBody: s.data.template.body,
          provider,
          sentBy: user || s.user || null,
          baseUrl: autoBaseUrl,
        });
        s.state = 'ask_another';
        const mockNote = provider.name === 'mock'
          ? '\n\n⚠ SMS provider is in mock mode (no real texts were sent). Add Whippy credentials in Admin → Settings to send for real.'
          : '';
        const bits = [`${result.sent} sent`];
        if (result.skippedCooldown) bits.push(`${result.skippedCooldown} skipped (cooldown)`);
        if (result.skippedDnc) bits.push(`${result.skippedDnc} skipped (do not contact)`);
        if (result.failed) bits.push(`${result.failed} failed (their cooldowns were NOT burned)`);
        return reply(s, `✅ Blast #${result.blastId} complete: ${bits.join(', ')}.${mockNote}\n\nSend another? (yes / no)`);
      }
      // Typed confirmation attempts are rejected — the button is the gate.
      if (/\b(yes|send|confirm|go|do it)\b/i.test(String(text || ''))) {
        return reply(s, BLAST_CONFIRM_REJECTION, {
          confirmButton: { action: 'confirm_send', label: `Send to ${s.data.plan.sendable.length} people` },
        });
      }
      return reply(s, 'Press the Send button when you\'re ready, or start a new conversation to cancel.');
    }

    if (s.state === 'ask_another') {
      if (/^y/i.test(String(text || ''))) { s.data = {}; return startBlast(s); }
      s.state = 'ended';
      return reply(s, 'Done. Start a new conversation any time.');
    }
    return reply(s, 'This conversation has ended — start a new one from the buttons above.');
  }

  // ---------- path: review ----------
  async function startReview(s) {
    s.state = 'report';
    const blasts = listBlasts(db, 20);
    if (!blasts.length) return reply(s, 'No magic blasts yet. Once you send one, its results show up here.', { blasts: [] });
    const lines = blasts.map((b) => {
      const d = new Date(b.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const bits = [`${b.sent_count} sent`];
      if (b.skipped_cooldown_count) bits.push(`${b.skipped_cooldown_count} skipped (cooldown)`);
      if (b.skipped_dnc_count) bits.push(`${b.skipped_dnc_count} skipped (DNC)`);
      if (b.failed_count) bits.push(`${b.failed_count} failed`);
      bits.push(`${b.interested_count} interested`);
      return `#${b.id} · ${d} · ${b.category}${b.sent_by ? ' · by ' + b.sent_by : ''} — ${bits.join(', ')}`;
    });
    return reply(s, `Recent Magic Blasts:\n\n${lines.join('\n')}`, { blasts });
  }

  // ---------- routing ----------
  async function start(path, user) {
    const s = newSession(path, user);
    if (path === 'job_order') return startJobOrder(s);
    if (path === 'blast') return startBlast(s);
    if (path === 'review') return startReview(s);
    // help — sandboxed: no db access anywhere in its handling
    s.state = 'chat';
    return reply(s, 'Help & Tutorials — ask me anything about how JobLink works. I can also simulate a walkthrough of any flow. (This is a sandbox: nothing I show is ever saved, sent, or published.)');
  }

  async function message(sessionId, input) {
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session_not_found', text: 'That conversation expired — start a new one from the buttons above.' };
    if (s.path === 'help') {
      // The ONLY thing the help path can do is produce text (src/ai/help-faq.js).
      const text = await answerHelpQuestion(input.text);
      return reply(s, text);
    }
    if (s.path === 'review') return startReview(s);
    if (s.path === 'job_order') return handleJobOrder(s, input);
    if (s.path === 'blast') return handleBlast(s, input);
    return { error: 'bad_path' };
  }

  return { start, message, sessions, BLAST_CONFIRM_REJECTION };
}

module.exports = { createTom, BLAST_CONFIRM_REJECTION, parseFieldEdit, parseManualContacts };
