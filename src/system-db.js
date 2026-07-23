// System database — manages orgs and users across all tenants.
// Lives at data/system.db. Each user has an org_id that maps to a tenant DB.

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const SYSTEM_SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  settings   TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL REFERENCES orgs(id),
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'recruiter' CHECK (role IN ('admin','recruiter')),
  email         TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  display_name  TEXT NOT NULL DEFAULT '',
  invite_token  TEXT,
  invite_expires TEXT,
  magic_login_token TEXT,
  magic_login_expires TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(org_id, username),
  UNIQUE(email)
);
`;

function openSystemDb(filePath) {
  const db = new DatabaseSync(filePath || path.join(__dirname, '..', 'data', 'system.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SYSTEM_SCHEMA);
  return db;
}

/** Create a new org and return its row. */
function createOrg(sysDb, { name, slug }) {
  if (!name || !slug) throw new Error('name and slug required');
  const cleanSlug = String(slug).toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!cleanSlug) throw new Error('invalid slug');
  const existing = sysDb.prepare('SELECT id FROM orgs WHERE slug = ?').get(cleanSlug);
  if (existing) throw new Error('slug already taken');
  const result = sysDb.prepare('INSERT INTO orgs (name, slug) VALUES (?, ?)').run(name, cleanSlug);
  return sysDb.prepare('SELECT * FROM orgs WHERE id = ?').get(Number(result.lastInsertRowid));
}

/** Find user by email or username (searches across all orgs). */
function findUser(sysDb, identifier) {
  let user = sysDb.prepare('SELECT * FROM users WHERE email = ?').get(String(identifier));
  if (!user) user = sysDb.prepare('SELECT * FROM users WHERE username = ?').get(String(identifier));
  return user || null;
}

/** Find user by email. */
function findUserByEmail(sysDb, email) {
  return sysDb.prepare('SELECT * FROM users WHERE email = ?').get(String(email)) || null;
}

/** Find user by invite token. */
function findUserByInviteToken(sysDb, token) {
  return sysDb.prepare('SELECT * FROM users WHERE invite_token = ?').get(String(token)) || null;
}

/** Find user by magic login token. */
function findUserByMagicToken(sysDb, token) {
  return sysDb.prepare('SELECT * FROM users WHERE magic_login_token = ?').get(String(token)) || null;
}

/** Get org by id. */
function getOrg(sysDb, id) {
  return sysDb.prepare('SELECT * FROM orgs WHERE id = ?').get(Number(id)) || null;
}

/** List all orgs. */
function listOrgs(sysDb) {
  return sysDb.prepare('SELECT * FROM orgs ORDER BY id').all();
}

/** List users for an org. */
function listOrgUsers(sysDb, orgId) {
  return sysDb.prepare(
    'SELECT id, org_id, username, role, email, email_verified, display_name, created_at FROM users WHERE org_id = ? ORDER BY id'
  ).all(orgId);
}

/** Update user fields. */
function updateUser(sysDb, userId, fields) {
  const allowed = ['password_hash', 'role', 'email', 'email_verified', 'display_name',
                   'invite_token', 'invite_expires', 'magic_login_token', 'magic_login_expires', 'username'];
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    sysDb.prepare(`UPDATE users SET ${key} = ? WHERE id = ?`).run(value, userId);
  }
  return sysDb.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

module.exports = {
  openSystemDb, createOrg, findUser, findUserByEmail,
  findUserByInviteToken, findUserByMagicToken, getOrg, listOrgs, listOrgUsers, updateUser,
};
