#!/usr/bin/env node
// Seed 3 changelog entries into all tenant DBs
const { openDb } = require('../src/db');
const { listOrgs } = require('../src/system-db');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const sysDb = new DatabaseSync(path.join(__dirname, '..', 'data', 'system.db'));
const orgs = sysDb.prepare('SELECT id FROM orgs').all();

const entries = [
  { version: '2.0', title: 'Multi-Tenant Architecture', body: 'Complete V2 rewrite with multi-tenant SQLite. Each organization gets its own isolated database. Per-category magic links, A/B testing on blasts, and scheduled blast support.' },
  { version: '2.1', title: 'Team Management & MFA', body: 'Manager view with recruiter performance metrics. TOTP-based multi-factor authentication for all users. Password complexity enforcement and invite system improvements.' },
  { version: '2.2', title: 'CSV Export & Analytics', body: 'Export blast analytics to CSV with date range filtering. Enhanced reporting dashboard with pipeline visualization and response rate tracking. Weekly email reports.' },
];

for (const org of orgs) {
  try {
    const db = openDb(org.id);
    // Ensure table exists
    db.exec(`CREATE TABLE IF NOT EXISTS changelog_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS email_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      subscribed INTEGER NOT NULL DEFAULT 1,
      unsub_token TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(email)
    )`);
    const existing = db.prepare('SELECT COUNT(*) as c FROM changelog_entries').get().c;
    if (existing === 0) {
      const stmt = db.prepare('INSERT INTO changelog_entries (version, title, body) VALUES (?, ?, ?)');
      entries.forEach(function(e) { stmt.run(e.version, e.title, e.body); });
      console.log('  Seeded ' + entries.length + ' entries for org ' + org.id);
    } else {
      console.log('  Org ' + org.id + ' already has ' + existing + ' entries, skipping seed');
    }
  } catch(e) {
    console.error('  Error seeding org ' + org.id + ':', e.message);
  }
}
console.log('Seed complete.');
