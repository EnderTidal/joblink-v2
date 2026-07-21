// Phone normalization — THE rule that keeps the primary key honest.
// Every phone number in JobLink is stored as exactly 10 digits (US format, no
// country code, no punctuation). "(555) 123-4567", "555-123-4567", "+1 555 123 4567"
// and "15551234567" are all the same person: "5551234567".
// See docs/DECISIONS.md — Blast Guard silently fails without this.

/**
 * Normalize any phone-number-ish input to a canonical 10-digit string.
 * Returns null when the input can't be a valid US phone number.
 */
function normalizePhone(input) {
  if (input === null || input === undefined) return null;
  let digits = String(input).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  if (digits[0] === '0' || digits[0] === '1') return null; // no valid US area code starts with 0/1
  return digits;
}

/** Format a canonical 10-digit phone for display: (555) 123-4567 */
function formatPhone(canonical) {
  const p = normalizePhone(canonical);
  if (!p) return String(canonical || '');
  return `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}`;
}

/** E.164 form used when handing a number to the messaging provider. */
function toE164(canonical) {
  const p = normalizePhone(canonical);
  return p ? `+1${p}` : null;
}

module.exports = { normalizePhone, formatPhone, toE164 };
