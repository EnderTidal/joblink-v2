// Job Orders — the enumerated field list (docs/DECISIONS.md; the spec review's
// fix #4). These eight fields ARE the Job Order template. The parser fills
// them, the eval tests grade against them, and the candidate page displays them.

const { CATEGORIES } = require('./blast');

const JOB_ORDER_FIELDS = [
  { key: 'title',        label: 'Title',        required: true },
  { key: 'category',     label: 'Category',     required: true }, // Industrial | Administrative | Skilled Trade
  { key: 'pay',          label: 'Pay',          required: true },
  { key: 'shift_hours',  label: 'Shift / Hours', required: false },
  { key: 'location',     label: 'Location',     required: false },
  { key: 'requirements', label: 'Requirements', required: false },
  { key: 'description',  label: 'Description',  required: false },
  { key: 'status',       label: 'Status',       required: true }, // Unpublished | Published | Complete
];

const STATUSES = ['Unpublished', 'Published', 'Complete'];

/** Validate a draft; returns { ok, missing: [], errors: [] }. */
function validateJobOrder(draft) {
  const missing = [];
  const errors = [];
  for (const f of JOB_ORDER_FIELDS) {
    if (f.required && !String(draft[f.key] || '').trim()) missing.push(f.key);
  }
  if (draft.category && !CATEGORIES.includes(draft.category)) {
    errors.push(`category must be one of: ${CATEGORIES.join(', ')}`);
  }
  if (draft.status && !STATUSES.includes(draft.status)) {
    errors.push(`status must be one of: ${STATUSES.join(', ')}`);
  }
  return { ok: missing.length === 0 && errors.length === 0, missing, errors };
}

function createJobOrder(db, draft) {
  const v = validateJobOrder(draft);
  if (!v.ok) throw new Error('Invalid job order: ' + [...v.missing, ...v.errors].join('; '));
  const r = db.prepare(
    `INSERT INTO job_orders (title, category, pay, shift_hours, location, requirements, description, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    draft.title.trim(), draft.category, String(draft.pay || '').trim(),
    String(draft.shift_hours || '').trim(), String(draft.location || '').trim(),
    String(draft.requirements || '').trim(), String(draft.description || '').trim(),
    draft.status || 'Unpublished',
  );
  return Number(r.lastInsertRowid);
}

function updateJobOrder(db, id, patch) {
  const jo = db.prepare('SELECT * FROM job_orders WHERE id = ?').get(id);
  if (!jo) throw new Error('Job order not found');
  const merged = { ...jo, ...patch };
  const v = validateJobOrder(merged);
  if (!v.ok) throw new Error('Invalid job order: ' + [...v.missing, ...v.errors].join('; '));
  db.prepare(
    `UPDATE job_orders SET title=?, category=?, pay=?, shift_hours=?, location=?, requirements=?, description=?, status=?,
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
  ).run(merged.title, merged.category, merged.pay, merged.shift_hours, merged.location,
        merged.requirements, merged.description, merged.status, id);
  return db.prepare('SELECT * FROM job_orders WHERE id = ?').get(id);
}

/** Dashboard-row actions (docs/DECISIONS.md — publishing later happens here). */
function setStatus(db, id, status) {
  if (!STATUSES.includes(status)) throw new Error('Bad status');
  return updateJobOrder(db, id, { status });
}

function listJobOrders(db, { status, category } = {}) {
  let sql = `SELECT jo.*, (SELECT COUNT(*) FROM interests i WHERE i.job_order_id = jo.id) AS interested_count
             FROM job_orders jo WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND jo.status = ?'; params.push(status); }
  if (category) { sql += ' AND jo.category = ?'; params.push(category); }
  sql += ' ORDER BY jo.id DESC';
  return db.prepare(sql).all(...params);
}

/** What a candidate sees on their magic link: published jobs in their current category. */
function publishedInCategory(db, category) {
  return db.prepare(
    `SELECT * FROM job_orders WHERE status = 'Published' AND category = ? ORDER BY id DESC`,
  ).all(category);
}

module.exports = {
  JOB_ORDER_FIELDS, STATUSES, validateJobOrder, createJobOrder, updateJobOrder,
  setStatus, listJobOrders, publishedInCategory,
};
