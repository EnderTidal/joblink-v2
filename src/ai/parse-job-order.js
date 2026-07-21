// AI-assisted parsing: uploaded document text → Job Order fields.
// Hybrid Vigor in practice: the AI's job here is narrow — fill a fixed
// template. It does not freelance outside that.
//
// Two engines, same output shape:
//  - Claude (when ANTHROPIC_API_KEY is set): reads the document and returns
//    the eight JOB_ORDER_FIELDS as JSON.
//  - Deterministic fallback (always available): heuristic extraction, so the
//    app works — and tests run — with no API key at all.
// Callers get { fields, engine, warnings }. Graded by eval-style tests
// (tests/ai-assisted/) — right information extracted, not exact wording.

const CATEGORY_HINTS = {
  Industrial: ['warehouse', 'forklift', 'assembly', 'production', 'manufactur', 'general labor', 'picker', 'packer', 'machine operator', 'loader', 'industrial'],
  'Skilled Trade': ['welder', 'welding', 'electric', 'hvac', 'cdl', 'plumb', 'carpent', 'maintenance tech', 'mechanic', 'machinist', 'skilled trade'],
  Administrative: ['office', 'clerical', 'data entry', 'receptionist', 'customer service', 'admin', 'bookkeep', 'clerk', 'front desk'],
};

function guessCategory(text) {
  const t = text.toLowerCase();
  let best = null, bestScore = 0;
  for (const [cat, hints] of Object.entries(CATEGORY_HINTS)) {
    const score = hints.reduce((n, h) => n + (t.includes(h) ? 1 : 0), 0);
    if (score > bestScore) { best = cat; bestScore = score; }
  }
  return best;
}

function grabLine(text, labels) {
  for (const label of labels) {
    const re = new RegExp(`^\\s*${label}\\s*[:\\-]\\s*(.+)$`, 'im');
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  return '';
}

/** Deterministic fallback parser. Never wrong about what it found; may find less. */
function parseDeterministic(text) {
  const warnings = [];
  const fields = {
    title: grabLine(text, ['job title', 'title', 'position', 'role']),
    category: grabLine(text, ['category', 'classification', 'type']),
    pay: grabLine(text, ['pay rate', 'pay', 'wage', 'salary', 'rate', 'compensation']),
    shift_hours: grabLine(text, ['shift/hours', 'shift', 'hours', 'schedule']),
    location: grabLine(text, ['location', 'city', 'address', 'site', 'worksite']),
    requirements: grabLine(text, ['requirements', 'qualifications', 'must have', 'needed']),
    description: grabLine(text, ['description', 'summary', 'details', 'duties', 'about the job']),
    status: 'Unpublished',
  };
  if (!fields.title) {
    const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 2);
    if (firstLine && firstLine.length <= 80) { fields.title = firstLine; warnings.push('title guessed from first line'); }
  }
  if (!fields.pay) {
    const m = text.match(/\$\s?\d[\d.,]*(\s?[-–to]+\s?\$?\s?\d[\d.,]*)?\s*(\/|per\s*)?(hr|hour|week|wk|yr|year|annual)?/i);
    if (m) { fields.pay = m[0].trim(); warnings.push('pay found by pattern match'); }
  }
  const normCat = ['Industrial', 'Administrative', 'Skilled Trade'].find(
    (c) => fields.category.toLowerCase().includes(c.toLowerCase()),
  );
  fields.category = normCat || guessCategory(text) || '';
  if (!fields.category) warnings.push('category could not be determined — recruiter must pick one');
  if (!fields.description) fields.description = text.trim().slice(0, 600);
  return { fields, engine: 'deterministic', warnings };
}

/** Claude-powered parser. Falls back to deterministic on any failure. */
async function parseWithClaude(text) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: process.env.JOBLINK_PARSE_MODEL || 'claude-haiku-4-5',
    max_tokens: 1000,
    system:
      'You extract job order fields from documents for a staffing agency. ' +
      'Respond ONLY with a JSON object with keys: title, category, pay, shift_hours, ' +
      'location, requirements, description. category must be exactly one of ' +
      '"Industrial", "Administrative", "Skilled Trade" (or "" if truly unclear). ' +
      'Use "" for anything not present. Do not invent details.',
    messages: [{ role: 'user', content: text.slice(0, 12000) }],
  });
  const raw = msg.content?.[0]?.text || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('no JSON in model response');
  const parsed = JSON.parse(jsonMatch[0]);
  const fields = {
    title: String(parsed.title || ''),
    category: String(parsed.category || ''),
    pay: String(parsed.pay || ''),
    shift_hours: String(parsed.shift_hours || ''),
    location: String(parsed.location || ''),
    requirements: String(parsed.requirements || ''),
    description: String(parsed.description || ''),
    status: 'Unpublished',
  };
  const warnings = [];
  if (!fields.category) warnings.push('category could not be determined — recruiter must pick one');
  return { fields, engine: 'claude', warnings };
}

async function parseJobOrderText(text) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return { fields: null, engine: 'none', warnings: ['empty document'] };
  if (process.env.ANTHROPIC_API_KEY) {
    try { return await parseWithClaude(clean); }
    catch (err) {
      const fallback = parseDeterministic(clean);
      fallback.warnings.push(`AI parse failed (${err.message}); used deterministic fallback`);
      return fallback;
    }
  }
  return parseDeterministic(clean);
}

/** Extract plain text from an uploaded job-order file (.docx, .txt; .doc best-effort). */
async function extractText(buffer, filename = '') {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.docx')) {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (lower.endsWith('.doc')) {
    // Legacy binary .doc: best-effort — strip to readable ASCII runs.
    const text = buffer.toString('latin1').replace(/[^\x20-\x7E\n\r\t]+/g, ' ');
    const runs = text.match(/[\x20-\x7E]{4,}/g) || [];
    const joined = runs.join(' ').replace(/\s+/g, ' ');
    if (joined.length < 40) throw new Error('Could not read this .doc file — please re-save it as .docx or .txt');
    return joined;
  }
  return buffer.toString('utf8'); // .txt and anything else
}

module.exports = { parseJobOrderText, parseDeterministic, extractText, guessCategory };
