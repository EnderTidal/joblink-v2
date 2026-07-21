// Name splitting — the parser edge case called out in the brief (§12).
// Contact lists sometimes arrive with one combined name column instead of
// separate first/last. Handles "John Smith", "Smith, John" (Q4 convention),
// and multi-part names deterministically.

/**
 * Split a combined name into { first, last }.
 * Rules (deterministic, in order):
 *  - "Last, First"  → comma form wins (Q4 exports names this way)
 *  - "First"        → last name empty
 *  - "First Middle... Last" → first token is the first name, the rest is the last name
 */
function splitName(combined) {
  const raw = String(combined || '').trim().replace(/\s+/g, ' ');
  if (!raw) return { first: '', last: '' };
  if (raw.includes(',')) {
    const [last, first] = raw.split(',', 2).map((s) => s.trim());
    return { first: first || '', last: last || '' };
  }
  const parts = raw.split(' ');
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

module.exports = { splitName };
