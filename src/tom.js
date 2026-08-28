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
//
// V2.1 changes:
//   - JO form UX overhaul: AI parses once -> full-width form replaces chat -> form-only editing
//   - Drag-and-drop upload support (client-side in tom.html, server already handled uploads)
//   - Recruiter assignment on blasts: recruiter dropdown in preview, passed through to executeBlast
//
// V2.2 changes:
//   - Blast form UX overhaul: after contacts parsed, full-width blast settings form replaces chat
//   - All blast settings (recipients, sort, category, template, recruiter) set via form, not chat
//   - Form submits all settings at once for preview, then gold confirm button sends

const crypto = require('node:crypto');
const { parseContactRows, parseContactFile, parseContactFileWithMap, parseExclusionFile, parseHeadersOnly, upsertCandidates, selectByLastContacted } = require('./importing');
const { normalizePhone } = require('./phone');
const { splitName } = require('./names');
const { planBlast, executeBlast, listBlasts, renderMessage, CATEGORIES } = require('./blast');
const { JOB_ORDER_FIELDS, validateJobOrder, createJobOrder } = require('./job-orders');
const { parseJobOrderText, extractText } = require('./ai/parse-job-order');
const { answerHelpQuestion } = require('./ai/help-faq');
const { getProvider, resolveNumber } = require('./messaging');
const { getSetting, getCooldownHours } = require('./db');

const PATHS = ['job_order', 'blast', 'review', 'help'];
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

const BLAST_CONFIRM_REJECTION =
  'For safety, sending requires pressing the Send button \u2014 a typed "yes" isn\'t enough. ' +
  'Real texts to real people get the strongest gate we have.';

const JOB_ORDER_EXAMPLE =
  'Type the details like this, or upload a .docx/.txt file:\n\n' +
  'Title: Forklift Operator\nCategory: Industrial\nPay: $18/hr\n' +
  'Shift: 1st shift, 6am-2:30pm\nAddress: 123 Main St, Your City, ST 00000\n' +
  'City/State: Your City, ST\n' +
  'Requirements: 6+ months forklift experience\nDescription: Move palletized goods in a climate-controlled warehouse.';

const SORT_OPTIONS = [
  { value: 'most_recent', label: 'Most Recently Contacted' },
  { value: 'least_recent', label: 'Least Recently Contacted' },
  { value: 'alpha_az', label: 'Alphabetical (A-Z)' },
  { value: 'alpha_za', label: 'Alphabetical (Z-A)' },
];

function draftSummary(draft) {
  const lines = JOB_ORDER_FIELDS.map((f) => `${f.label}: ${draft[f.key] || '\u2014'}`);
  const v = validateJobOrder(draft);
  if (!v.ok) {
    lines.push('');
    if (v.missing.length) lines.push(`\u26A0 Missing required: ${v.missing.join(', ')}`);
    v.errors.forEach((e) => lines.push(`\u26A0 ${e}`));
  }
  return lines.join('\n');
}

// Deterministic field-edit command parsing: "set pay to $18.50", "pay: $18.50",
// "location should be Ennis TX", "change title to Welder"
const FIELD_KEYS = {
  title: 'title', category: 'category', pay: 'pay', wage: 'pay', salary: 'pay',
  shift: 'shift_hours', hours: 'shift_hours', schedule: 'shift_hours', 'shift/hours': 'shift_hours',
  address: 'address', location: 'city_state', city: 'city_state', state: 'city_state', 'city/state': 'city_state',
  requirements: 'requirements', description: 'description', company: 'company',
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

// Manual contact entry: one contact per line
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

/** Sort contacts by the chosen sort option */
function sortContacts(contacts, sortBy) {
  const sorted = [...contacts];
  switch (sortBy) {
    case 'most_recent':
      sorted.sort((a, b) => {
        const ta = a.lastContacted ? a.lastContacted.getTime() : -Infinity;
        const tb = b.lastContacted ? b.lastContacted.getTime() : -Infinity;
        return tb - ta;
      });
      break;
    case 'least_recent':
      sorted.sort((a, b) => {
        const ta = a.lastContacted ? a.lastContacted.getTime() : Infinity;
        const tb = b.lastContacted ? b.lastContacted.getTime() : Infinity;
        return ta - tb;
      });
      break;
    case 'alpha_az':
      sorted.sort((a, b) => {
        const na = `${a.last || ''} ${a.first || ''}`.trim().toLowerCase();
        const nb = `${b.last || ''} ${b.first || ''}`.trim().toLowerCase();
        return na.localeCompare(nb);
      });
      break;
    case 'alpha_za':
      sorted.sort((a, b) => {
        const na = `${a.last || ''} ${a.first || ''}`.trim().toLowerCase();
        const nb = `${b.last || ''} ${b.first || ''}`.trim().toLowerCase();
        return nb.localeCompare(na);
      });
      break;
    default:
      break;
  }
  return sorted;
}

function createTom(db) {
  const sessions = new Map();

  function newSession(path, user, displayName) {
    if (!PATHS.includes(path)) throw new Error('Unknown path');
    const id = crypto.randomBytes(12).toString('base64url');
    const s = { id, path, user: user || null, displayName: displayName || user || null, state: 'start', data: {}, createdAt: Date.now() };
    sessions.set(id, s);
    for (const [k, v] of sessions) if (Date.now() - v.createdAt > SESSION_TTL_MS) sessions.delete(k);
    return s;
  }

  function reply(session, text, extra = {}) {
    return { sessionId: session.id, path: session.path, state: session.state, text, ...extra };
  }

  // ---------- path: job_order ----------
  async function startJobOrder(s) {
    s.state = 'await_input';
    return reply(s, `Let's create a Job Order.\n\nDrag and drop a .docx or .txt file with the job details, or start with a blank form below.`, { showBlankFormLink: true });
  }

  async function handleJobOrder(s, { text, action, payload, file }) {
    if (s.state === 'await_input') {
      if (action === 'blank_form') {
        s.data.draft = {
          title: '', category: '', pay: '', shift_hours: '', address: '',
          city_state: '', requirements: '', description: '', company: '', status: 'Unpublished',
        };
        s.state = 'review';
        return reply(s, '', { showForm: true, draft: s.data.draft, warnings: [] });
      }

      let docText = text || '';
      if (file) docText = await extractText(file.buffer, file.originalname);
      if (!docText.trim()) return reply(s, 'Drop a .docx or .txt file with the job details, or use the blank form below.', { showBlankFormLink: true });
      const parsed = await parseJobOrderText(docText);
      if (!parsed.fields) return reply(s, 'That document looks empty \u2014 try again?', { showBlankFormLink: true });
      s.data.draft = parsed.fields;
      s.state = 'review';
      return reply(s, '', { showForm: true, draft: s.data.draft, warnings: parsed.warnings, fields: JOB_ORDER_FIELDS });
    }

    if (s.state === 'review') {
      const draft = s.data.draft;

      if (action === 'start_over') {
        s.data = {};
        return startJobOrder(s);
      }

      if ((action === 'publish' || action === 'done') && payload?.draft) {
        Object.assign(draft, payload.draft);
        if (action === 'publish') draft.status = 'Published';
        else if (draft.status === 'Published') { /* keep */ } else draft.status = 'Unpublished';

        const v = validateJobOrder(draft);
        if (!v.ok) {
          const errors = [...v.missing.map((m) => `missing ${m}`), ...v.errors];
          return reply(s, `Can't save yet \u2014 ${errors.join('; ')}.`,
            { showForm: true, draft, warnings: errors });
        }
        if (!draft.assigned_recruiter) draft.assigned_recruiter = s.displayName || s.user || '';
        const id = createJobOrder(db, draft);
        s.state = 'ask_another';
        if (action === 'publish') {
          return reply(s, `\u2705 Published job order #${id}: ${draft.title} (${draft.category}). It's live on the job board now.\n\nWant to create another? (yes / no)`);
        }
        return reply(s, `\uD83D\uDCBE Saved job order #${id}: ${draft.title} (${draft.status}). You can publish it later from the Dashboard.\n\nWant to create another? (yes / no)`);
      }

      if (action === 'edit_field' && payload?.field) {
        draft[payload.field] = String(payload.value ?? '').trim();
        return reply(s, `Updated.\n\n${draftSummary(draft)}`, { showForm: true, draft, warnings: [] });
      }

      const t = String(text || '').trim();
      if (/\b(publish|go live|publish it|ship it|looks good|good to go|make it live)\b/i.test(t)) {
        draft.status = 'Published';
        const v = validateJobOrder(draft);
        if (!v.ok) return reply(s, `Can't publish yet \u2014 ${[...v.missing.map((m) => `missing ${m}`), ...v.errors].join('; ')}.\n\n${draftSummary(draft)}`, { showForm: true, draft, warnings: v.missing });
        if (!draft.assigned_recruiter) draft.assigned_recruiter = s.displayName || s.user || '';
        const id = createJobOrder(db, draft);
        s.state = 'ask_another';
        return reply(s, `\u2705 Published job order #${id}: ${draft.title} (${draft.category}). It's live on the job board now.\n\nWant to create another? (yes / no)`);
      }
      if (/\b(done|save|keep it|finish|save it)\b/i.test(t)) {
        draft.status = draft.status === 'Published' ? 'Published' : 'Unpublished';
        const v = validateJobOrder(draft);
        if (!v.ok) return reply(s, `Almost \u2014 ${[...v.missing.map((m) => `missing ${m}`), ...v.errors].join('; ')}.\n\n${draftSummary(draft)}`, { showForm: true, draft, warnings: v.missing });
        if (!draft.assigned_recruiter) draft.assigned_recruiter = s.displayName || s.user || '';
        const id = createJobOrder(db, draft);
        s.state = 'ask_another';
        return reply(s, `\uD83D\uDCBE Saved job order #${id}: ${draft.title} (${draft.status}). You can publish it later from the Dashboard.\n\nWant to create another? (yes / no)`);
      }
      const edit = parseFieldEdit(t);
      if (edit) {
        if (edit.field === 'category') {
          const cat = CATEGORIES.find((c) => c.toLowerCase() === edit.value.toLowerCase().replace(/s$/, ''))
            || CATEGORIES.find((c) => edit.value.toLowerCase().includes(c.toLowerCase()));
          if (!cat) return reply(s, `Category has to be one of: ${CATEGORIES.join(', ')}.`, { showForm: true, draft, warnings: [] });
          draft.category = cat;
        } else if (edit.field === 'status') {
          return reply(s, 'Say "publish" to publish, or "done" to save unpublished \u2014 status changes go through those.', { showForm: true, draft, warnings: [] });
        } else {
          draft[edit.field] = edit.value;
        }
        return reply(s, `Updated.\n\n${draftSummary(draft)}`, { showForm: true, draft, warnings: [] });
      }
      return reply(s, 'Edit fields in the form, or use "publish" / "Save as Draft" buttons.', { showForm: true, draft, warnings: [] });
    }

    if (s.state === 'ask_another') {
      if (/^y/i.test(String(text || ''))) { s.data = {}; return startJobOrder(s); }
      s.state = 'ended';
      return reply(s, 'All set. Start a new conversation any time you need another job order.');
    }
    return reply(s, 'This conversation has ended \u2014 start a new one from the buttons above.');
  }

  // ---------- path: blast ----------
  async function startBlast(s) {
    s.state = 'await_contacts';
    return reply(s,
      'Let\'s send a Magic Blast. Upload a contact list (.csv or Excel), or type contacts one per line like:\n\n' +
      'John Smith 555-123-4567\nJane Doe (555) 987-6543');
  }

  /** Load templates and Whippy users for blast form */
  function loadBlastFormData(category) {
    const templates = db.prepare('SELECT * FROM templates ORDER BY is_default DESC, id').all();
    const catDefault = category ? templates.find(t => t.is_default && t.category === category) : null;
    const globalDefault = templates.find(t => t.is_default && (!t.category || t.category === ''));
    const defaultTemplate = catDefault || globalDefault || templates[0] || null;

    let whippyUsers = [];
    const wu = getSetting(db, 'whippy_users');
    if (wu) { try { whippyUsers = JSON.parse(wu); } catch { /* ignore */ } }

    const localUsers = db.prepare('SELECT id, username, role FROM users ORDER BY username').all();

    // Multi-number support: load configured numbers
    let whippyNumbers = [];
    const wn = getSetting(db, 'whippy_numbers');
    if (wn) { try { whippyNumbers = JSON.parse(wn); } catch { /* ignore */ } }
    // Backward compat: if no whippy_numbers, build from single fields
    if (!whippyNumbers.length) {
      const fn = getSetting(db, 'whippy_from_number');
      const ci = getSetting(db, 'whippy_channel_id');
      if (fn && ci) whippyNumbers = [{ from_number: fn, channel_id: ci, label: 'Primary' }];
    }

    return { templates, defaultTemplate, whippyUsers, localUsers, whippyNumbers };
  }

  async function handleBlast(s, { text, action, payload, file, user, reqHost, reqProto, orgSlug }) {
    if (s.state === 'await_contacts') {
      // Manual text entry: skip column mapping, go straight to blast form
      if (!file && String(text || '').trim()) {
        const parsed = parseManualContacts(text);
        if (!parsed.contacts.length) {
          return reply(s, `I couldn't find any valid phone numbers in that${parsed.invalid.length ? ` (${parsed.invalid.length} rows had unusable numbers)` : ''}. Try again?`);
        }
        const counts = upsertCandidates(db, parsed.contacts);
        s.data.contacts = parsed.contacts;
        s.data.invalidCount = parsed.invalid.length;
        s.data.importCounts = counts;
        s.data.hasLastContacted = parsed.contacts.some(c => c.lastContacted);
        s.state = 'blast_form';
        const _totalPool = db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n;
        const cooldownHrs = getCooldownHours(db);
        const cooldownCutoff = new Date(Date.now() - cooldownHrs * 3600000).toISOString();
        const parsedPhones = parsed.contacts.map(c => c.phone);
        let inCooldown = 0, inDnc = 0;
        const checkStmt = db.prepare('SELECT last_blast, do_not_contact FROM candidates WHERE phone = ?');
        for (const p of parsedPhones) {
          const row = checkStmt.get(p);
          if (!row) continue;
          if (row.do_not_contact) { inDnc++; continue; }
          if (row.last_blast && row.last_blast > cooldownCutoff) { inCooldown++; }
        }
        const estimatedSendable = parsed.contacts.length - inCooldown - inDnc;
        const formData = loadBlastFormData(null);
        return reply(s, '', {
          showBlastForm: true,
          contactCount: parsed.contacts.length,
          estimatedSendable,
          estimatedCooldown: inCooldown,
          estimatedDnc: inDnc,
          totalCandidates: _totalPool,
          invalidCount: parsed.invalid.length,
          importCounts: counts,
          hasLastContacted: parsed.contacts.some(c => c.lastContacted),
          excludedCount: s.data.excludedCount || 0,
          exclusionTotal: s.data.exclusionTotal || 0,
          exclusionFileName: s.data.exclusionFileName || null,
          categories: CATEGORIES,
          sortOptions: SORT_OPTIONS,
          templates: formData.templates.map(t => ({ id: t.id, name: t.name, body: t.body, category: t.category || '', is_default: !!t.is_default })),
          defaultTemplateId: formData.defaultTemplate ? formData.defaultTemplate.id : null,
          whippyUsers: formData.whippyUsers,
          localUsers: formData.localUsers.map(u => ({ id: u.id, username: u.username, role: u.role })),
          whippyNumbers: formData.whippyNumbers,
        });
      }
      // File upload: show column mapping step
      if (file) {
        const headerPreview = parseHeadersOnly(file.buffer, file.originalname);
        if (!headerPreview.headers.length) {
          return reply(s, 'Could not read any headers from that file. Try a different file?');
        }
        s.data.fileBuffer = file.buffer.toString('base64');
        s.data.fileName = file.originalname;
        s.state = 'await_column_map';
        return reply(s, '', {
          showColumnMap: true,
          headers: headerPreview.headers,
          sampleRows: headerPreview.sampleRows,
          suggestedMap: headerPreview.suggestedMap,
        });
      }
      return reply(s, 'Upload a contact list or type contacts to get started.');
    }

    // ---------- state: await_column_map ----------
    if (s.state === 'await_column_map') {
      if (action === 'back_to_upload') {
        s.data = {};
        return startBlast(s);
      }
      if (action === 'start_over') {
        s.data = {};
        return startBlast(s);
      }
      if (action === 'confirm_column_map') {
        const columnMap = payload && payload.columnMap;
        if (!columnMap) return reply(s, 'Please confirm your column mapping.', { showColumnMap: true, keepForm: true });
        const hasPhone = Object.values(columnMap).some(v => v === 'phone');
        if (!hasPhone) return reply(s, 'You must map at least one column to Phone.', { showColumnMap: true, keepForm: true });
        const buf = Buffer.from(s.data.fileBuffer, 'base64');
        const parsed = parseContactFileWithMap(buf, columnMap, s.data.fileName);
        if (!parsed.contacts.length) {
          return reply(s, 'No valid contacts found with that mapping. Try adjusting your column assignments.', { showColumnMap: true, keepForm: true });
        }
        const counts = upsertCandidates(db, parsed.contacts);
        s.data.contacts = parsed.contacts;
        s.data.invalidCount = parsed.invalid.length;
        s.data.importCounts = counts;
        s.data.hasLastContacted = parsed.contacts.some(c => c.lastContacted);
        // Move to exclusion list step
        s.state = 'await_exclusion';
        return reply(s, '', {
          showExclusionUpload: true,
          contactCount: parsed.contacts.length,
          invalidCount: parsed.invalid.length,
        });
      }
      return reply(s, 'Please confirm your column mapping or start over.');
    }

    // ---------- state: await_exclusion ----------
    if (s.state === 'await_exclusion') {
      if (action === 'back_to_column_map') {
        s.state = 'await_column_map';
        const buf = Buffer.from(s.data.fileBuffer, 'base64');
        const headerPreview = parseHeadersOnly(buf, s.data.fileName);
        return reply(s, '', {
          showColumnMap: true,
          headers: headerPreview.headers,
          sampleRows: headerPreview.sampleRows,
          suggestedMap: headerPreview.suggestedMap,
        });
      }
      if (action === 'start_over') {
        s.data = {};
        return startBlast(s);
      }
      if (action === 'skip_exclusion') {
        s.data.exclusionPhones = [];
        s.state = 'blast_form';
        const _totalPool = db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n;
        const cooldownHrs = getCooldownHours(db);
        const cooldownCutoff = new Date(Date.now() - cooldownHrs * 3600000).toISOString();
        const parsedPhones = s.data.contacts.map(c => c.phone);
        let inCooldown = 0, inDnc = 0;
        const checkStmt = db.prepare('SELECT last_blast, do_not_contact FROM candidates WHERE phone = ?');
        for (const p of parsedPhones) {
          const row = checkStmt.get(p);
          if (!row) continue;
          if (row.do_not_contact) { inDnc++; continue; }
          if (row.last_blast && row.last_blast > cooldownCutoff) { inCooldown++; }
        }
        const estimatedSendable = s.data.contacts.length - inCooldown - inDnc;
        const formData = loadBlastFormData(null);
        return reply(s, '', {
          showBlastForm: true,
          contactCount: s.data.contacts.length,
          estimatedSendable,
          estimatedCooldown: inCooldown,
          estimatedDnc: inDnc,
          totalCandidates: _totalPool,
          invalidCount: s.data.invalidCount || 0,
          importCounts: s.data.importCounts || {},
          hasLastContacted: s.data.hasLastContacted || false,
          excludedCount: s.data.excludedCount || 0,
          exclusionTotal: s.data.exclusionTotal || 0,
          exclusionFileName: s.data.exclusionFileName || null,
          categories: CATEGORIES,
          sortOptions: SORT_OPTIONS,
          templates: formData.templates.map(t => ({ id: t.id, name: t.name, body: t.body, category: t.category || '', is_default: !!t.is_default })),
          defaultTemplateId: formData.defaultTemplate ? formData.defaultTemplate.id : null,
          whippyUsers: formData.whippyUsers,
          localUsers: formData.localUsers.map(u => ({ id: u.id, username: u.username, role: u.role })),
          whippyNumbers: formData.whippyNumbers,
        });
      }
      if (file) {
        const excResult = parseExclusionFile(file.buffer, file.originalname);
        s.data.exclusionPhones = excResult.phones;
        const exclSet = new Set(excResult.phones);
        const originalCount = s.data.contacts.length;
        s.data.contacts = s.data.contacts.filter(c => !exclSet.has(c.phone));
        s.data.excludedCount = originalCount - s.data.contacts.length;
        s.data.exclusionTotal = excResult.count;
        s.data.exclusionFileName = file.originalname;
        s.state = 'blast_form';
        const _totalPool = db.prepare('SELECT COUNT(*) AS n FROM candidates').get().n;
        const cooldownHrs = getCooldownHours(db);
        const cooldownCutoff = new Date(Date.now() - cooldownHrs * 3600000).toISOString();
        const parsedPhones = s.data.contacts.map(c => c.phone);
        let inCooldown = 0, inDnc = 0;
        const checkStmt = db.prepare('SELECT last_blast, do_not_contact FROM candidates WHERE phone = ?');
        for (const p of parsedPhones) {
          const row = checkStmt.get(p);
          if (!row) continue;
          if (row.do_not_contact) { inDnc++; continue; }
          if (row.last_blast && row.last_blast > cooldownCutoff) { inCooldown++; }
        }
        const estimatedSendable = s.data.contacts.length - inCooldown - inDnc;
        const formData = loadBlastFormData(null);
        return reply(s, '', {
          showBlastForm: true,
          contactCount: s.data.contacts.length,
          estimatedSendable,
          estimatedCooldown: inCooldown,
          estimatedDnc: inDnc,
          totalCandidates: _totalPool,
          invalidCount: s.data.invalidCount || 0,
          importCounts: s.data.importCounts || {},
          hasLastContacted: s.data.hasLastContacted || false,
          excludedCount: s.data.excludedCount || 0,
          exclusionTotal: s.data.exclusionTotal || 0,
          exclusionFileName: s.data.exclusionFileName || null,
          categories: CATEGORIES,
          sortOptions: SORT_OPTIONS,
          templates: formData.templates.map(t => ({ id: t.id, name: t.name, body: t.body, category: t.category || '', is_default: !!t.is_default })),
          defaultTemplateId: formData.defaultTemplate ? formData.defaultTemplate.id : null,
          whippyUsers: formData.whippyUsers,
          localUsers: formData.localUsers.map(u => ({ id: u.id, username: u.username, role: u.role })),
          whippyNumbers: formData.whippyNumbers,
        });
      }
      return reply(s, 'Upload an exclusion list or click Skip to continue.');
    }

    if (s.state === 'blast_form') {
      if (action === 'back_to_exclusion') {
        s.state = 'await_exclusion';
        return reply(s, '', {
          showExclusionUpload: true,
          contactCount: s.data.contacts.length,
          invalidCount: s.data.invalidCount || 0,
        });
      }
      if (action === 'start_over') {
        s.data = {};
        return startBlast(s);
      }

      if (action === 'save_template') {
        const name = String(payload?.name || '').trim();
        const body = String(payload?.body || '').trim();
        const category = payload?.category || null;
        if (!name || !body) return reply(s, 'Template needs a name and body.', { showBlastForm: true, keepForm: true });
        const r = db.prepare('INSERT INTO templates (name, body, category) VALUES (?, ?, ?)').run(name, body, category || null);
        const newTemplate = db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(r.lastInsertRowid));
        const allTemplates = db.prepare('SELECT * FROM templates ORDER BY is_default DESC, id').all();
        return reply(s, '', {
          showBlastForm: true,
          keepForm: true,
          savedTemplate: { id: newTemplate.id, name: newTemplate.name, body: newTemplate.body, category: newTemplate.category || '', is_default: !!newTemplate.is_default },
          templates: allTemplates.map(t => ({ id: t.id, name: t.name, body: t.body, category: t.category || '', is_default: !!t.is_default })),
        });
      }

      if (action === 'preview_blast') {
        const recipientMode = payload?.recipientMode || 'all';
        const recipientCount = parseInt(payload?.recipientCount || '0', 10);
        const sortBy = payload?.sortBy || 'most_recent';
        const category = payload?.category;
        const templateId = payload?.templateId ? Number(payload.templateId) : null;
        const templateBody = payload?.templateBody || '';
        const recruiterId = payload?.recruiterId ? Number(payload.recruiterId) : null;
        const selectedFromNumber = payload?.fromNumber || null;

        if (!CATEGORIES.includes(category)) {
          return reply(s, 'Select a category before previewing.', { showBlastForm: true, keepForm: true });
        }
        if (!templateBody.trim()) {
          return reply(s, 'Template message cannot be empty.', { showBlastForm: true, keepForm: true });
        }

        let selected = sortContacts(s.data.contacts, sortBy);

        if (recipientMode === 'top' && recipientCount > 0 && recipientCount < selected.length) {
          selected = selected.slice(0, recipientCount);
        }

        s.data.selection = selected;
        s.data.category = category;

        if (templateId) {
          const t = db.prepare('SELECT * FROM templates WHERE id = ?').get(templateId);
          if (t) s.data.template = t;
          else s.data.template = { id: null, name: 'Custom', body: templateBody };
        } else {
          s.data.template = { id: null, name: 'Custom', body: templateBody };
        }
        if (templateBody && templateBody !== s.data.template.body) {
          s.data.template = { ...s.data.template, body: templateBody };
        }

        s.data.recruiterId = recruiterId;
        s.data.selectedFromNumber = selectedFromNumber;

        const plan = planBlast(db, { phones: selected.map(c => c.phone), category });
        s.data.plan = plan;

        const sample = plan.sendable[0]
          ? renderMessage(s.data.template.body, plan.sendable[0], getSetting(db, 'base_url') || '')
          : '(no sendable recipients)';
        const skippedBits = [];
        if (plan.skippedCooldown.length) skippedBits.push(`${plan.skippedCooldown.length} skipped (cooldown)`);
        if (plan.skippedDnc.length) skippedBits.push(`${plan.skippedDnc.length} skipped (do not contact)`);

        let recruiterUsername = null;
        if (recruiterId) {
          // Look up in Whippy users (the dropdown uses Whippy IDs, not local user IDs)
          try {
            const wu = JSON.parse(getSetting(db, 'whippy_users') || '[]');
            const match = wu.find(u => u.id === recruiterId);
            if (match) recruiterUsername = match.name || match.email;
          } catch { /* ignore */ }
          // Fallback to local users
          if (!recruiterUsername) {
            const rec = db.prepare('SELECT username FROM users WHERE id = ?').get(recruiterId);
            if (rec) recruiterUsername = rec.username;
          }
        }
        s.data.recruiterUsername = recruiterUsername;

        s.state = 'preview';
        return reply(s,
          `Blast preview \u2014 ${category}\n` +
          `Template: ${s.data.template.name}\n` +
          `Sample message: "${sample}"\n\n` +
          `${plan.sendable.length} will be sent${skippedBits.length ? ', ' + skippedBits.join(', ') : ''}.\n` +
          (recruiterUsername ? `Recruiter: ${recruiterUsername}\n` : '') +
          '\nPress the Send button to send. You can safely close this tab after \u2014 your blast will continue in the background.',
          {
            confirmButton: { action: 'confirm_send', label: `Send to ${plan.sendable.length} people` },
            plan: { sendable: plan.sendable.map(c => ({ first_name: c.first_name, last_name: c.last_name, phone: c.phone })) },
          });
      }

      return reply(s, 'Use the blast settings form to configure your blast, then click Preview Blast.', { showBlastForm: true, keepForm: true });
    }

    if (s.state === 'preview') {
      if (action === 'back_to_form') {
        s.state = 'blast_form';
        const formData = loadBlastFormData(s.data.category);
        return reply(s, '', {
          showBlastForm: true,
          contactCount: s.data.contacts.length,
          invalidCount: s.data.invalidCount || 0,
          importCounts: s.data.importCounts || {},
          hasLastContacted: s.data.hasLastContacted || false,
          categories: CATEGORIES,
          sortOptions: SORT_OPTIONS,
          templates: formData.templates.map(t => ({ id: t.id, name: t.name, body: t.body, category: t.category || '', is_default: !!t.is_default })),
          defaultTemplateId: s.data.template?.id || (formData.defaultTemplate ? formData.defaultTemplate.id : null),
          whippyUsers: formData.whippyUsers,
          localUsers: formData.localUsers.map(u => ({ id: u.id, username: u.username, role: u.role })),
          whippyNumbers: formData.whippyNumbers,
        });
      }

      if (action === 'confirm_send') {
        if (!s.data.plan.sendable.length) return reply(s, 'Nobody to send to \u2014 everyone was skipped.');
        s.state = 'sending';
        // Resolve multi-number: pass selected fromNumber override to provider
        const numberOverride = s.data.selectedFromNumber ? resolveNumber(db, s.data.selectedFromNumber) : null;
        const provider = getProvider(db, numberOverride);
        const autoBaseUrl = reqHost ? ((reqProto === 'http' && reqHost.includes('localhost')) ? `http://${reqHost}` : `https://${reqHost}`) : undefined;

        const recruiterId = s.data.recruiterId || null;
        const recruiterUsername = s.data.recruiterUsername || null;
        console.log('[blast] Sending blast: category=' + s.data.category + ' sendable=' + s.data.plan.sendable.length + ' recruiterId=' + recruiterId + ' recruiterName=' + recruiterUsername);

        const result = await executeBlast(db, s.data.plan, {
          templateId: s.data.template.id,
          templateBody: s.data.template.body,
          provider,
          sentBy: user || s.user || null,
          baseUrl: autoBaseUrl,
          orgSlug,
          recruiterId,
          recruiterUsername,
        });
        s.state = 'ask_another';
        const mockNote = provider.name === 'mock'
          ? '\n\n\u26A0 SMS provider is in mock mode (no real texts were sent). Add Whippy credentials in Admin \u2192 Settings to send for real.'
          : '';
        const bits = [`${result.sent} sent`];
        if (result.skippedCooldown) bits.push(`${result.skippedCooldown} skipped (cooldown)`);
        if (result.skippedDnc) bits.push(`${result.skippedDnc} skipped (do not contact)`);
        if (result.failed) bits.push(`${result.failed} failed (their cooldowns were NOT burned)`);
        const recruiterNote = recruiterUsername ? `\nRecruiter assigned: ${recruiterUsername}` : '';
        const tips = '\n\n\uD83D\uDCC8 **Want better results?**\n' +
          '\u2022 Import more contacts \u2014 the bigger your pool, the more interest you\u2019ll get\n' +
          '\u2022 Try different categories \u2014 Industrial and Skilled Trade respond differently\n' +
          '\u2022 Blast again in 72 hours \u2014 candidates who missed it the first time may respond';
        return reply(s, `\u2705 Blast #${result.blastId} complete: ${bits.join(', ')}.${recruiterNote}${mockNote}${tips}\n\nSend another? (yes / no)`);
      }
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
    return reply(s, 'This conversation has ended \u2014 start a new one from the buttons above.');
  }

  // ---------- path: review ----------
  async function startReview(s) {
    s.state = 'report';
    const orgTz = (db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() || {}).value || 'America/Chicago';
    const blasts = listBlasts(db, 20);
    if (!blasts.length) return reply(s, 'No magic blasts yet. Once you send one, its results show up here.', { blasts: [], timezone: orgTz });
    const lines = blasts.map((b) => {
      const d = new Date(b.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: orgTz });
      const bits = [`${b.sent_count} sent`];
      if (b.skipped_cooldown_count) bits.push(`${b.skipped_cooldown_count} skipped (cooldown)`);
      if (b.skipped_dnc_count) bits.push(`${b.skipped_dnc_count} skipped (DNC)`);
      if (b.failed_count) bits.push(`${b.failed_count} failed`);
      bits.push(`${b.interested_count} interested`);
      return `#${b.id} \u00B7 ${d} \u00B7 ${b.category}${b.sent_by ? ' \u00B7 by ' + b.sent_by : ''} \u2014 ${bits.join(', ')}`;
    });
    return reply(s, `Recent Magic Blasts:\n\n${lines.join('\n')}`, { blasts, timezone: orgTz });
  }

  // ---------- routing ----------
  async function start(path, user, displayName) {
    const s = newSession(path, user, displayName);
    if (path === 'job_order') return startJobOrder(s);
    if (path === 'blast') return startBlast(s);
    if (path === 'review') return startReview(s);
    s.state = 'help_topics';
    return reply(s, '\ud83d\udcfa Watch the full walkthrough: https://www.loom.com/share/e4e782f6d42647438af99a84c6ecfb4a\n\nPick a topic to learn more:', {
      helpTopics: [
        { key: 'job_orders', label: 'Job Orders & Editing' },
        { key: 'blasts', label: 'Magic Blasts & Templates' },
        { key: 'blast_guard', label: 'Blast Guard & Cooldowns' },
        { key: 'imports', label: 'Imports & File Format' },
        { key: 'categories', label: 'Categories' },
        { key: 'whippy', label: 'Whippy Setup' },
        { key: 'team', label: 'Team Members & Roles' },
        { key: 'practice', label: 'Practice Mode vs Live' },
        { key: 'magic_link', label: 'What Candidates See' },
        { key: 'troubleshoot', label: 'Error Troubleshooting' },
      ]
    });
  }

  async function message(sessionId, input) {
    const s = sessions.get(sessionId);
    if (!s) return { error: 'session_not_found', text: 'That conversation expired \u2014 start a new one from the buttons above.' };
    if (s.path === 'help') {
      if (input.action === 'help_topic') {
        const topicAnswers = {
          job_orders: 'Click any job order on the Dashboard to view details. Click Edit to change fields. Unpublish to hide from candidates. Archive to remove from active view.\n\nTo create a new JO: click New Job Order, upload a .docx/.txt file or use the blank form. Fields: title, category (Industrial/Administrative/Skilled Trade), pay, shift/hours, location, requirements, description.',
          blasts: 'Blast messages come from templates (Admin \u2192 Templates) using {first_name} and {link} placeholders. A template without {link} is rejected \u2014 a magic blast without the magic link is just a text.\n\nTo send: click Send Magic Blast, upload your contact list (.csv or Excel), pick category and template, preview, then press Send.',
          blast_guard: 'Blast Guard stops anyone from getting a new magic link within the cooldown window (default 72 hours), no matter which category the blast is for. Skipped people are shown in your preview BEFORE you send \u2014 e.g. "287 will send, 13 skipped (cooldown)".\n\nAdjust the cooldown window in Admin \u2192 Settings.',
          imports: 'CSV or XLSX with columns: first_name, last_name, phone (required). Optional: last_contacted (used for filtering only, not stored).\n\nOn import, a phone number we already have with a different name gets its NAME updated \u2014 nothing else. Phone number is the anchor.',
          categories: 'Three fixed categories: Industrial, Administrative, Skilled Trade. Set on job orders and candidates. Blasts send to candidates matching the JO\u2019s category. Candidates see only JOs matching their category on their magic link page.',
          whippy: 'To connect Whippy: go to Admin \u2192 Settings, enter your Whippy API Key, SMS From Number, and Channel ID. You can find these in Whippy under Settings \u2192 Developers. Once connected, blasts will send real texts.',
          team: 'Admin \u2192 Users to invite recruiters. Roles: admin (full access) or recruiter (limited). Each user gets their own login.',
          practice: 'Without Whippy connected, you\u2019re in practice mode \u2014 everything works except texts don\u2019t actually send. Connect Whippy in Admin \u2192 Settings to go live.',
          magic_link: 'Each candidate has ONE permanent magic link. It shows every PUBLISHED job order in the category of their most recent blast. They tap "I\u2019m Interested" on any job right on that page \u2014 no texting back needed.',
          troubleshoot: '"Blast failed" usually means Whippy is not connected or your API key expired \u2014 check Admin \u2192 Settings. "No candidates matched" means the wrong category was selected or all candidates are in cooldown.',
        };
        const answer = topicAnswers[input.payload?.topic] || 'Pick a topic from the list above.';
        return reply(s, answer, {
          helpTopics: [
            { key: 'job_orders', label: 'Job Orders & Editing' },
            { key: 'blasts', label: 'Magic Blasts & Templates' },
            { key: 'blast_guard', label: 'Blast Guard & Cooldowns' },
            { key: 'imports', label: 'Imports & File Format' },
            { key: 'categories', label: 'Categories' },
            { key: 'whippy', label: 'Whippy Setup' },
            { key: 'team', label: 'Team Members & Roles' },
            { key: 'practice', label: 'Practice Mode vs Live' },
            { key: 'magic_link', label: 'What Candidates See' },
            { key: 'troubleshoot', label: 'Error Troubleshooting' },
          ]
        });
      }
      // If somehow free text arrives, redirect to topics
      return reply(s, 'Pick a topic below to learn more:', {
        helpTopics: [
          { key: 'job_orders', label: 'Job Orders & Editing' },
          { key: 'blasts', label: 'Magic Blasts & Templates' },
          { key: 'blast_guard', label: 'Blast Guard & Cooldowns' },
          { key: 'imports', label: 'Imports & File Format' },
          { key: 'categories', label: 'Categories' },
          { key: 'whippy', label: 'Whippy Setup' },
          { key: 'team', label: 'Team Members & Roles' },
          { key: 'practice', label: 'Practice Mode vs Live' },
          { key: 'magic_link', label: 'What Candidates See' },
          { key: 'troubleshoot', label: 'Error Troubleshooting' },
        ]
      });
    }
    if (s.path === 'review') return startReview(s);
    if (s.path === 'job_order') return handleJobOrder(s, input);
    if (s.path === 'blast') return handleBlast(s, input);
    return { error: 'bad_path' };
  }

  return { start, message, sessions, BLAST_CONFIRM_REJECTION };
}

module.exports = { createTom, BLAST_CONFIRM_REJECTION, parseFieldEdit, parseManualContacts, sortContacts };
