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
  first: ['first name', 'firstname', 'first', 'fname', 'formal first name', 'formal first', 'given name'],
  last: ['last name', 'lastname', 'last', 'lname', 'surname', 'formal last name', 'formal last', 'family name'],
  name: ['name', 'full name', 'fullname', 'contact', 'contact name', 'candidate', 'candidate name'],
  phone: ['phone', 'phone number', 'phone#', 'cell', 'cell phone', 'cellphone', 'mobile', 'mobile phone', 'mobilephone', 'mobile number', 'cell number', 'number', 'text number', 'text', 'telephone', 'home phone', 'homephone', 'work phone', 'workphone'],
  lastContacted: ['last contacted', 'last contact', 'lastcontacted', 'last contact date', 'date last contacted'],
};

// Keyword-based fallback matching: if a normalized header CONTAINS one of these
// keywords, map it to the corresponding field. Order matters — checked top-down,
// and within each rule the first keyword hit wins.
const KEYWORD_RULES = [
  // phone keywords (before name — "contact number" should map to phone, not name)
  { field: 'phone', keywords: ['phone', 'cell', 'mobile', 'telephone', 'text', 'sms'] },
  // lastContacted keywords (before name — "last contact date" contains "contact")
  { field: 'lastContacted', keywords: ['contacted', 'last activity', 'recent activity', 'date last', 'last contact', 'recent'] },
  // name keywords
  { field: 'name', keywords: ['applicant', 'associate', 'employee', 'worker', 'candidate'] },
];

/**
 * Normalize a raw header string for matching:
 *  - lowercase
 *  - split camelCase ("CellPhone" -> "cell phone")
 *  - replace underscores, hyphens, dots, extra spaces with single space
 *  - trim
 */
function normalizeHeader(raw) {
  let h = String(raw || '');
  // Split camelCase: insert space before each uppercase letter that follows a lowercase
  h = h.replace(/([a-z])([A-Z])/g, '$1 $2');
  // Lowercase and replace separators with space
  h = h.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return h;
}

function matchHeader(header) {
  const h = normalizeHeader(header);
  if (!h) return null;

  // 1) Exact alias match (primary — keeps full backwards compatibility)
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(h)) return field;
  }

  // 2) Keyword/substring fallback
  for (const rule of KEYWORD_RULES) {
    for (const kw of rule.keywords) {
      if (h.includes(kw)) return rule.field;
    }
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
    // Collect all phone columns (files often have Home Phone, Cell Phone, Text, etc.)
    const phoneColumns = [];
    firstRow.forEach((field, i) => {
      if (field === 'phone') {
        phoneColumns.push({ index: i, header: normalizeHeader(rows[0][i]) });
      } else if (field && map[field] === undefined) {
        map[field] = i;
      }
    });
    // Sort phone columns: prefer cell/mobile/text over home/work, then left-to-right
    const PHONE_PRIORITY = ['cell', 'mobile', 'text', 'sms'];
    phoneColumns.sort((a, b) => {
      const aP = PHONE_PRIORITY.some(k => a.header.includes(k)) ? 0 : 1;
      const bP = PHONE_PRIORITY.some(k => b.header.includes(k)) ? 0 : 1;
      return aP - bP || a.index - b.index;
    });
    map.phone = phoneColumns.length ? phoneColumns[0].index : undefined;
    // Store fallback phone columns for rows where primary is empty
    map._phoneColumns = phoneColumns.map(c => c.index);
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
    // Try each phone column until we find a valid number
    let phone = null;
    const phoneCols = map._phoneColumns || (map.phone !== undefined ? [map.phone] : []);
    for (const idx of phoneCols) {
      const candidate = normalizePhone(row[idx]);
      if (candidate) { phone = candidate; break; }
    }
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
  // Dedup within the file itself: same phone twice -> last occurrence wins
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



/**
 * Parse just the headers + sample rows from an uploaded file.
 * Returns { headers: string[], sampleRows: array[], suggestedMap: { colIndex: fieldName } }
 */
function parseHeadersOnly(buffer, filename = '') {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!rows.length) return { headers: [], sampleRows: [], suggestedMap: {} };

  const headers = rows[0].map(h => String(h || '').trim());
  const sampleRows = rows.slice(1, 4).map(r => r.map(c => {
    if (c instanceof Date) {
      const m = c.getMonth() + 1, d = c.getDate(), y = c.getFullYear();
      return (m < 10 ? '0' : '') + m + '/' + (d < 10 ? '0' : '') + d + '/' + y;
    }
    return String(c ?? '');
  }));

  // Build suggested mapping using matchHeader
  const suggestedMap = {};
  headers.forEach((h, i) => {
    const field = matchHeader(h);
    if (field === 'name') {
      // Detect name format from sample data: Last, First vs First Last
      const samples = sampleRows.map(r => String(r[i] || '')).filter(Boolean);
      const commaCount = samples.filter(s => s.includes(',')).length;
      suggestedMap[i] = commaCount > samples.length / 2 ? 'name_lf' : 'name_fl';
    } else if (field) {
      suggestedMap[i] = field;
    }
  });

  return { headers, sampleRows, suggestedMap, totalRows: Math.max(0, rows.length - 1) };
}

/**
 * Parse a contact file using a user-provided column mapping.
 * columnMap is { first?: colIndex, last?: colIndex, name?: colIndex, phone?: colIndex, lastContacted?: colIndex }
 * where colIndex is the 0-based column index.
 */
function parseContactFileWithMap(buffer, columnMap, filename = '') {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!rows.length) return { contacts: [], invalid: [], headerMap: columnMap, filename };

  // Skip header row
  const dataRows = rows.slice(1);
  const map = {};
  // Convert columnMap field->index format
  for (const [idx, field] of Object.entries(columnMap)) {
    if (field && field !== 'skip') {
      const colIdx = Number(idx);
      if (field === 'phone') {
        if (!map._phoneColumns) map._phoneColumns = [];
        map._phoneColumns.push(colIdx);
        if (map.phone === undefined) map.phone = colIdx;
      } else if (map[field] === undefined) {
        map[field] = colIdx;
      }
    }
  }

  const contacts = [];
  const invalid = [];
  for (const row of dataRows) {
    if (!row.some((c) => String(c).trim() !== '')) continue;
    let first = '', last = '';
    if (map.first !== undefined || map.last !== undefined) {
      first = String(row[map.first] ?? '').trim();
      last = String(row[map.last] ?? '').trim();
      if (first && !last && first.includes(' ')) ({ first, last } = splitName(first));
    } else if (map.name_fl !== undefined) {
      // User explicitly said First Last
      const raw = String(row[map.name_fl] || '').trim();
      if (raw.includes(',')) {
        // Data looks like Last, First despite user picking First Last — trust the comma
        const [l, f] = raw.split(',', 2).map(s => s.trim());
        first = f || ''; last = l || '';
      } else {
        const parts = raw.split(/\s+/);
        first = parts[0] || '';
        last = parts.slice(1).join(' ');
      }
    } else if (map.name_lf !== undefined) {
      // User explicitly said Last, First
      const raw = String(row[map.name_lf] || '').trim();
      if (raw.includes(',')) {
        const [l, f] = raw.split(',', 2).map(s => s.trim());
        first = f || ''; last = l || '';
      } else {
        // No comma — treat last token as first name (best guess)
        const parts = raw.split(/\s+/);
        last = parts[0] || '';
        first = parts.slice(1).join(' ');
      }
    } else if (map.name !== undefined) {
      ({ first, last } = splitName(row[map.name]));
    }
    let phone = null;
    const phoneCols = map._phoneColumns || (map.phone !== undefined ? [map.phone] : []);
    for (const idx of phoneCols) {
      const candidate = normalizePhone(row[idx]);
      if (candidate) { phone = candidate; break; }
    }
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
  const byPhone = new Map();
  for (const c of contacts) byPhone.set(c.phone, c);
  return { contacts: [...byPhone.values()], invalid, headerMap: map, filename };
}

/**
 * Extract phone numbers from an exclusion file.
 * Tries to find any phone column automatically.
 */
function parseExclusionFile(buffer, filename = '') {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!rows.length) return { phones: [], count: 0 };

  // Try to detect which columns contain phones
  const firstRow = rows[0].map(matchHeader);
  const hasHeader = firstRow.some(f => f !== null);
  let phoneCols = [];

  if (hasHeader) {
    firstRow.forEach((field, i) => {
      if (field === 'phone') phoneCols.push(i);
    });
  }

  const dataRows = hasHeader ? rows.slice(1) : rows;

  // If no phone column detected by header, scan all columns for phone-like data
  if (!phoneCols.length && dataRows.length > 0) {
    for (let i = 0; i < (dataRows[0] || []).length; i++) {
      // Check first few data rows to see if this column has phone-like content
      let phoneHits = 0;
      for (let r = 0; r < Math.min(5, dataRows.length); r++) {
        if (normalizePhone(dataRows[r]?.[i])) phoneHits++;
      }
      if (phoneHits >= 1) phoneCols.push(i);
    }
  }

  const phones = new Set();
  for (const row of dataRows) {
    if (!row.some(c => String(c).trim() !== '')) continue;
    for (const col of phoneCols) {
      const p = normalizePhone(row[col]);
      if (p) { phones.add(p); break; }
    }
  }

  return { phones: [...phones], count: phones.size };
}

module.exports = { parseContactFile, parseContactRows, upsertCandidates, selectByLastContacted, matchHeader, normalizeHeader, parseHeadersOnly, parseContactFileWithMap, parseExclusionFile };
