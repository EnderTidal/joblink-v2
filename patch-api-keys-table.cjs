// Patch 1: Add api_keys table migration to system-db.js
const fs = require('fs');
const file = '/root/joblink-v2-staging/src/system-db.js';
let src = fs.readFileSync(file, 'utf8');

const TABLE_DDL = `
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  org_id INTEGER NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  name TEXT DEFAULT 'Default',
  created_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`;

// Add to SYSTEM_SCHEMA const (before closing backtick)
const schemaEnd = "const SYSTEM_SCHEMA = `";
if (!src.includes('api_keys')) {
  // Find the schema constant and append our table before its closing backtick
  src = src.replace(
    /^(const SYSTEM_SCHEMA = `[\s\S]*?)(`;)/m,
    (_, schema, end) => schema + TABLE_DDL + end
  );
  fs.writeFileSync(file, src);
  console.log('✓ api_keys table added to SYSTEM_SCHEMA');
} else {
  console.log('✓ api_keys already present — skipping');
}
