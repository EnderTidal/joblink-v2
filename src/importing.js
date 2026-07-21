// Contact-list importing: parse CSV/Excel, normalize phones, split names,
// and upsert candidates under the Overwrite Rule.
//
// Overwrite Rule (PROJECT_BRIEF §9 — never silently broken):
//   phone match + different name → overwrite the NAME ONLY.
//   last_blast, blast_count, magic_token, do_not_contact: NEVER touched on import.
//
// Last Contacted (§5, §8 — never stored): it exists only on the in-memory rows
// returned from parsing, is used once for sort/limit inside a blast session,
// and is never written to the candidates table. There is no column for it.

const XLSX = require('xlsx');
const { normalizePhone } = require('./phone');
const { splitName } = require('./names');
const { newMagicToken } = require('./db');

const HEADER_ALIASES = {
  first: ['first name', 'firstname', 'first', 'fname'],
  last: ['last name', 'lastname', 'last', 'lname', 'surname'],
  name: ['name', 'full name', 'fullname', 'contact', 'contact name', 'candidate', 'candidate name'],
  phone: ['phone', 'phone number', 'phone#', 'cell', 'cell phone', 'mobile', 'number', 'text number', 'telephone'],
  lastContacted: ['last contacted', 'last contact', 'lastcontacted', 'last contact date', 'date last contacted'],
};

function matchHeader(header) {
  const h = String(header || '').toLowerCase().trim().replace(/[_\-]+/g, ' ');
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(h)) return field;
  }
  return null;
}

/**
 * Parse an uploaded contact file (.csv, .xlsx, .xls) into normalized rows:
 *   { first, last, phone, lastContacted (Date|null), raw }
 * Invalid phone numbers are returned separately, never silently dropped.
 */
function parseContactFile(buffer, filename = '') {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  return parseContactRows(rows, filename);
}

/** Same, from a 2D array (first row may be headers). */
function parseContactRows(rows, filename = '') {
  if (!rows.length) return { contacts: [], invalid: [], headerMap: null };

  // Detect header row: does the first row map to at least a phone-ish column?
  const firstRow = rows[0].map(matchHeader);
  const hasHeader = firstRow.some((f) => f !== null);
  let map = {};
  let dataRows;
  if (hasHeader) {
    firstRow.forEach((field, i) => { if (field && map[field] === undefined) map[field] = i; });
    dataRows = rows.slice(1);
  } else {
    // No header: guess columns — find the phone column by content, name is what precedes it
    const probe = rows[0];
    let phoneIdx = probe.findIndex((cell) => normalizePhone(cell));
    if (phoneIdx === -1) phoneIdx = probe.length - 1;
    if (phoneIdx >= 2) { map = { first: 0, last: 1, phone: phoneIdx }; }
    else { map = { name: 0, phone: phoneIdx }; }
    dataRows = rows;
  }

  const contacts = [];
  const invalid = [];
  for (const row of dataRows) {
    if (!row.some((c) => String(c).trim() !== '')) continue; // blank line
    let first = '', last = '';
    if (map.first !== undefined || map.last !== undefined) {
      first = String(row[map.first] ?? '').trim();
      last = String(row[map.last] ?? '').trim();
      // Edge case: "first" column actually holds a combined name
      if (first && !last && first.includes(' ')) ({ first, last } = splitName(first));
    } else if (map.name !== undefined) {
      ({ first, last } = splitName(row[map.name]));
    }
    const phoneRaw = map.phone !== undefined ? row[map.phone] : '';
    const phone = normalizePhone(phoneRaw);
    let lastContacted = null;
    if (map.lastContacted !== undefined) {
      const v = row[map.lastContacted];
      if (v instanceof Date) lastContacted = v;
      else if (String(v).trim()) {
        const d = new Date(String(v).trim());
        if (!Number.isNaN(d.getTime())) lastContacted = d;
      }
    }
    if (!phone) { invalid.push({ row, reason: 'bad_phone' }); continue; }
    contacts.push({ first, last, phone, lastContacted, raw: row });
  }
  // Dedup within the file itself: same phone twice → last occurrence wins
  const byPhone = new Map();
  for (const c of contacts) byPhone.set(c.phone, c);
  return { contacts: [...byPhone.values()], invalid, headerMap: map, filename };
}

/**
 * Upsert parsed contacts into the candidates table under the Overwrite Rule.
 * Returns { created, updated, unchanged }.
 */
function upsertCandidates(db, contacts) {
  const get = db.prepare('SELECT phone, first_name, last_name FROM candidates WHERE phone = ?');
  const insert = db.prepare(
    'INSERT INTO candidates (phone, first_name, last_name, magic_token) VALUES (?, ?, ?, ?)',
  );
  const updateName = db.prepare(
    'UPDATE candidates SET first_name = ?, last_name = ? WHERE phone = ?',
  );
  let created = 0, updated = 0, unchanged = 0;
  for (const c of contacts) {
    const existing = get.get(c.phone);
    if (!existing) {
      insert.run(c.phone, c.first, c.last, newMagicToken());
      created++;
    } else if (existing.first_name !== c.first || existing.last_name !== c.last) {
      if (c.first || c.last) { updateName.run(c.first, c.last, c.phone); updated++; }
      else unchanged++; // imported row had no name — don't blank out what we have
    } else {
      unchanged++;
    }
  }
  return { created, updated, unchanged };
}

/**
 * Ephemeral Last Contacted selection (§8): sort newest-first, take N.
 * Pure function over the in-memory upload — the dates die with the session.
 */
function selectByLastContacted(contacts, limit) {
  const sorted = [...contacts].sort((a, b) => {
    const ta = a.lastContacted ? a.lastContacted.getTime() : -Infinity;
    const tb = b.lastContacted ? b.lastContacted.getTime() : -Infinity;
    return tb - ta;
  });
  return limit && limit > 0 ? sorted.slice(0, limit) : sorted;
}

module.exports = { parseContactFile, parseContactRows, upsertCandidates, selectByLastContacted, matchHeader };
