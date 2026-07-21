// AI-assisted parsing — EVALUATION-style tests (SHAPE.md testing philosophy):
// grade that the RIGHT INFORMATION was extracted, not that wording matches.
// Runs against the deterministic fallback always; if ANTHROPIC_API_KEY is set,
// the same rubric grades the Claude engine too (npm run test:ai with a key).
const { test } = require('node:test');
const assert = require('node:assert');
const { parseJobOrderText, parseDeterministic, guessCategory } = require('../../src/ai/parse-job-order');

const SAMPLES = [
  {
    name: 'clean labeled doc',
    text: `Job Title: Forklift Operator
Category: Industrial
Pay Rate: $18.00/hr
Shift: 1st shift, Mon-Fri 6:00am-2:30pm
Location: Waxahachie, TX
Requirements: 6+ months forklift experience, able to lift 50 lbs
Description: Move palletized goods in a climate-controlled warehouse.`,
    expect: {
      title: /forklift/i, category: 'Industrial', pay: /18/, shift: /6|1st|Mon/i, location: /waxahachie/i,
      requirements: /forklift|50/i,
    },
  },
  {
    name: 'messy prose doc (no labels)',
    text: `Express Employment — Waxahachie office

We need a welder for a local fabrication shop. MIG and TIG experience required,
2 years minimum. Pays $24-$28 per hour depending on experience. Second shift,
2pm to 10:30pm. Steel-toe boots required. The shop is in Ennis, TX.`,
    expect: { title: /weld/i, category: 'Skilled Trade', pay: /24|28/ },
  },
  {
    name: 'admin role with odd labels',
    text: `POSITION: Front Office Coordinator
COMPENSATION: $16.50 hourly
SCHEDULE: Monday through Friday, 8am to 5pm
SITE: Midlothian, TX
MUST HAVE: Excel, 45 WPM typing, customer service attitude
ABOUT THE JOB: Answer phones, greet visitors, data entry for the sales team.`,
    expect: { title: /coordinator|front office/i, category: 'Administrative', pay: /16\.?5/ },
  },
];

function grade(fields, expect, engineName, sampleName) {
  assert.ok(fields, `${engineName}/${sampleName}: parser returned fields`);
  if (expect.title) assert.match(fields.title, expect.title, `${engineName}/${sampleName}: title ("${fields.title}")`);
  if (expect.category) assert.strictEqual(fields.category, expect.category, `${engineName}/${sampleName}: category ("${fields.category}")`);
  if (expect.pay) assert.match(fields.pay, expect.pay, `${engineName}/${sampleName}: pay ("${fields.pay}")`);
  if (expect.shift) assert.match(fields.shift_hours, expect.shift, `${engineName}/${sampleName}: shift ("${fields.shift_hours}")`);
  if (expect.location) assert.match(fields.location, expect.location, `${engineName}/${sampleName}: location ("${fields.location}")`);
  if (expect.requirements) assert.match(fields.requirements, expect.requirements, `${engineName}/${sampleName}: requirements`);
  assert.strictEqual(fields.status, 'Unpublished', 'parsed drafts always start Unpublished');
}

for (const sample of SAMPLES) {
  test(`deterministic engine extracts the right info: ${sample.name}`, () => {
    const { fields } = parseDeterministic(sample.text);
    // The fallback engine is graded on labeled docs fully; on prose docs we
    // require category + pay (title may need the recruiter's touch).
    const expectations = sample.name.includes('messy') ? { category: sample.expect.category, pay: sample.expect.pay } : sample.expect;
    grade(fields, expectations, 'deterministic', sample.name);
  });
}

test('category guessing from raw text', () => {
  assert.strictEqual(guessCategory('forklift and warehouse work'), 'Industrial');
  assert.strictEqual(guessCategory('MIG welding position'), 'Skilled Trade');
  assert.strictEqual(guessCategory('front desk receptionist'), 'Administrative');
  assert.strictEqual(guessCategory('completely unrelated text about cats'), null);
});

test('empty document is handled, not crashed on', async () => {
  const r = await parseJobOrderText('');
  assert.strictEqual(r.fields, null);
  assert.ok(r.warnings.includes('empty document'));
});

if (process.env.ANTHROPIC_API_KEY) {
  for (const sample of SAMPLES) {
    test(`claude engine extracts the right info: ${sample.name}`, async () => {
      const { fields, engine } = await parseJobOrderText(sample.text);
      assert.strictEqual(engine, 'claude');
      grade(fields, sample.expect, 'claude', sample.name);
    });
  }
} else {
  test('claude engine evals skipped — set ANTHROPIC_API_KEY to grade the AI parser', () => {
    assert.ok(true);
  });
}
