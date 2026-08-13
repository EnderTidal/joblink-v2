#!/usr/bin/env node
// One-time backfill: create interest_events for all existing interests rows.
// Run from /root/joblink-v2-staging/: node scripts/backfill-interest-events.js

const { openDb } = require('../src/db');
const { getTenantDb } = require('../src/tenant');
const { openSystemDb, listOrgs } = require('../src/system-db');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const sysDb = openSystemDb(process.env.SYSTEM_DB || path.join(DATA_DIR, 'system.db'));

const orgs = listOrgs(sysDb);
let totalBackfilled = 0;

for (const org of orgs) {
  const dbPath = path.join(DATA_DIR, `org-${org.id}.db`);
  if (!fs.existsSync(dbPath)) {
    console.log(`[org-${org.id}] ${org.name}: no tenant DB, skipping`);
    continue;
  }

  try {
    const db = getTenantDb(org.id);

    // Check if backfill already ran (any events with changed_by='backfill')
    const existingBackfill = db.prepare(
      "SELECT COUNT(*) AS n FROM interest_events WHERE changed_by = 'backfill'"
    ).get().n;
    if (existingBackfill > 0) {
      console.log(`[org-${org.id}] ${org.name}: already backfilled (${existingBackfill} events), skipping`);
      continue;
    }

    const interests = db.prepare('SELECT phone, job_order_id, status, created_at FROM interests').all();
    if (interests.length === 0) {
      console.log(`[org-${org.id}] ${org.name}: no interests, skipping`);
      continue;
    }

    const insert = db.prepare(
      'INSERT INTO interest_events (phone, job_order_id, from_status, to_status, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)'
    );

    let count = 0;
    for (const interest of interests) {
      insert.run(
        interest.phone,
        interest.job_order_id,
        null,
        interest.status,
        'backfill',
        interest.created_at
      );
      count++;
    }

    console.log(`[org-${org.id}] ${org.name}: backfilled ${count} events`);
    totalBackfilled += count;
  } catch (e) {
    console.error(`[org-${org.id}] ${org.name}: ERROR — ${e.message}`);
  }
}

console.log(`\nDone. Total backfilled: ${totalBackfilled}`);
