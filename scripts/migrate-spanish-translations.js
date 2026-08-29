#!/usr/bin/env node
// migrate-spanish-translations.js
// Adds Spanish translation columns to all org DBs and translates published JOs.
// Idempotent — safe to re-run. Uses Claude Haiku 4.5 for translations.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('ERROR: Set ANTHROPIC_API_KEY env var');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const ORG_DB_PATTERN = /^org-\d+\.db$/;

// ── Step 1: Add columns to all org DBs ──
function addSpanishColumns(dbPath) {
  const db = new DatabaseSync(dbPath);
  let added = 0;
  for (const col of ['title_es', 'description_es', 'requirements_es']) {
    try {
      db.exec(`ALTER TABLE job_orders ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
      added++;
      console.log(`  + Added ${col} to ${path.basename(dbPath)}`);
    } catch {
      // Column already exists
    }
  }
  if (added === 0) console.log(`  ✓ ${path.basename(dbPath)} already has Spanish columns`);
  db.close();
}

// ── Step 2: Translate JOs with empty _es fields ──
async function translateJO(jo) {
  const prompt = `Translate the following job posting to Spanish. Keep it professional and natural — this is for blue-collar staffing candidates. Return ONLY valid JSON with keys: title_es, description_es, requirements_es. No markdown, no code fences.

Title: ${jo.title}

Description: ${jo.description || '(none)'}

Requirements: ${jo.requirements || '(none)'}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic API ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const text = data.content?.[0]?.text || '';
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  return JSON.parse(cleaned);
}

async function translateOrgJOs(dbPath) {
  const db = new DatabaseSync(dbPath);
  const dbName = path.basename(dbPath);

  // Check if columns exist by trying a select
  try {
    db.prepare('SELECT title_es FROM job_orders LIMIT 1').get();
  } catch {
    console.log(`  ⚠ ${dbName} missing Spanish columns — skipping translations`);
    db.close();
    return 0;
  }

  // Find JOs that need translation
  const rows = db.prepare(`
    SELECT id, title, description, requirements
    FROM job_orders
    WHERE status = 'Published'
      AND (title != '' OR description != '' OR requirements != '')
      AND (title_es = '' AND description_es = '' AND requirements_es = '')
  `).all();

  if (rows.length === 0) {
    console.log(`  ✓ ${dbName}: no JOs need translation`);
    db.close();
    return 0;
  }

  console.log(`  → ${dbName}: translating ${rows.length} JOs...`);
  const update = db.prepare(`
    UPDATE job_orders SET title_es = ?, description_es = ?, requirements_es = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `);

  let translated = 0;
  for (const jo of rows) {
    try {
      const es = await translateJO(jo);
      update.run(es.title_es || '', es.description_es || '', es.requirements_es || '', jo.id);
      translated++;
      console.log(`    ✓ JO #${jo.id} "${jo.title}" → "${es.title_es}"`);
    } catch (err) {
      console.error(`    ✗ JO #${jo.id} "${jo.title}": ${err.message}`);
    }
    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  db.close();
  return translated;
}

async function main() {
  console.log('=== Spanish Translation Migration ===\n');

  const dbFiles = fs.readdirSync(DATA_DIR)
    .filter(f => ORG_DB_PATTERN.test(f))
    .map(f => path.join(DATA_DIR, f))
    .sort();

  console.log(`Found ${dbFiles.length} org databases\n`);

  // Step 1: Add columns
  console.log('Step 1: Adding Spanish columns...');
  for (const dbPath of dbFiles) {
    addSpanishColumns(dbPath);
  }

  // Step 2: Translate (only org-1 by default, pass --all for all)
  const translateAll = process.argv.includes('--all');
  const targetDbs = translateAll ? dbFiles : dbFiles.filter(f => f.includes('org-1.db'));

  console.log(`\nStep 2: Translating JOs in ${translateAll ? 'ALL' : 'org-1'} databases...`);
  let total = 0;
  for (const dbPath of targetDbs) {
    total += await translateOrgJOs(dbPath);
  }

  console.log(`\n=== Done! Translated ${total} job orders ===`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
