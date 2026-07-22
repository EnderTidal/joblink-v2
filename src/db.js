// Database — SQLite via Node's built-in node:sqlite. Zero native deps.
// "It's literally just a DB and a parser." This is the DB.
//
// The schema encodes the data model from docs/PROJECT_BRIEF.md §5 plus the
// four fixes from docs/SPEC_REVIEW_2026-07-21.md:
//   - blasts table (per-blast reporting + recruiter attribution)
//   - interests.blast_id (interested-replies-per-blast is countable)
//   - candidates.do_not_contact (STOP = infinite cooldown)
//   - candidates.current_category (most-recent-blast-wins link category)

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candidates (
  phone            TEXT PRIMARY KEY,          -- canonical 10 digits (src/phone.js)
  first_name       TEXT NOT NULL DEFAULT '',
  last_name        TEXT NOT NULL DEFAULT '',
  magic_token      TEXT NOT NULL UNIQUE,      -- random, unguessable; the magic link is /m/<token>
  current_category TEXT,                      -- Industrial | Administrative | Skilled Trade; most recent blast wins
  last_blast       TEXT,                      -- ISO timestamp; drives Blast Guard; ONLY contact-recency field stored
  blast_count      INTEGER NOT NULL DEFAULT 0,
  do_not_contact   INTEGER NOT NULL DEFAULT 0,-- STOP replies; infinite cooldown
  assigned_recruiter TEXT,                    -- extension point (PORTING_FROM_V1) — not surfaced yet
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS job_orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('Industrial','Administrative','Skilled Trade')),
  pay          TEXT NOT NULL DEFAULT '',
  shift_hours  TEXT NOT NULL DEFAULT '',
  location     TEXT NOT NULL DEFAULT '',
  requirements TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  company      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'Unpublished' CHECK (status IN ('Unpublished','Published','Complete')),
  assigned_recruiter TEXT,                    -- extension point
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS blasts (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  category               TEXT NOT NULL,
  template_id            INTEGER,
  message_preview        TEXT NOT NULL DEFAULT '',
  sent_count             INTEGER NOT NULL DEFAULT 0,
  skipped_cooldown_count INTEGER NOT NULL DEFAULT 0,
  skipped_dnc_count      INTEGER NOT NULL DEFAULT 0,
  failed_count           INTEGER NOT NULL DEFAULT 0,
  sent_by                TEXT                        -- recruiter attribution
);

CREATE TABLE IF NOT EXISTS blast_recipients (
  blast_id  INTEGER NOT NULL REFERENCES blasts(id),
  phone     TEXT NOT NULL,
  status    TEXT NOT NULL CHECK (status IN ('sent','skipped_cooldown','skipped_dnc','failed')),
  error     TEXT,
  PRIMARY KEY (blast_id, phone)
);

CREATE TABLE IF NOT EXISTS interests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  phone        TEXT NOT NULL REFERENCES candidates(phone),
  job_order_id INTEGER NOT NULL REFERENCES job_orders(id),
  blast_id     INTEGER,                       -- which blast brought them in (nullable)
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (phone, job_order_id)
);

CREATE TABLE IF NOT EXISTS templates (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  body    TEXT NOT NULL,                      -- placeholders: {first_name}, {link}
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'recruiter' CHECK (role IN ('admin','recruiter')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  author     TEXT,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS changelog (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  version    TEXT NOT NULL,
  notes      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

const DEFAULT_SETTINGS = {
  onboarded: '0',                // first-login setup wizard not yet completed
  cooldown_hours: '72',          // Blast Guard default — "3 days" means exactly 72 hours
  base_url: 'https://v2.joblinkplatform.com',
  sms_provider: 'mock',          // 'whippy' once credentials are entered in Admin
  whippy_api_key: '',
  whippy_channel_id: '',
  whippy_from_number: '',
};

const DEFAULT_TEMPLATE_BODY =
  'Hi {first_name}! Express Employment has new job openings matching your skills. ' +
  'View and apply here: {link} — Reply STOP to opt out';

function openDb(filePath) {
  const db = new DatabaseSync(filePath || path.join(__dirname, '..', 'data', 'joblink.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Migration: add category column to templates (for category-based defaults)
  try { db.exec("ALTER TABLE templates ADD COLUMN category TEXT"); } catch { /* already exists */ }
  // Migration: split location into address + city_state
  try { db.exec("ALTER TABLE job_orders ADD COLUMN address TEXT NOT NULL DEFAULT ''"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE job_orders ADD COLUMN city_state TEXT NOT NULL DEFAULT ''"); } catch { /* already exists */ }
  try { db.exec("UPDATE job_orders SET city_state = location WHERE city_state = '' AND location != ''"); } catch { /* no-op */ }
  // Seed defaults (INSERT OR IGNORE keeps this idempotent)
  const seed = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) seed.run(k, v);
  const tCount = db.prepare('SELECT COUNT(*) AS n FROM templates').get().n;
  if (tCount === 0) {
    db.prepare('INSERT INTO templates (name, body, is_default) VALUES (?, ?, 1)').run(
      'Standard Magic Blast', DEFAULT_TEMPLATE_BODY,
    );
  }
  return db;
}

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function getCooldownHours(db) {
  const v = Number(getSetting(db, 'cooldown_hours'));
  return Number.isFinite(v) && v >= 0 ? v : 72;
}

/** Random, unguessable magic-link token (docs/DECISIONS.md — never derived from the phone number). */
function newMagicToken() {
  return crypto.randomBytes(16).toString('base64url');
}

module.exports = { openDb, getSetting, setSetting, getCooldownHours, newMagicToken, DEFAULT_TEMPLATE_BODY };
