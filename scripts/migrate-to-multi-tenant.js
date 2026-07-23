#!/usr/bin/env node
// Migration script: converts a single-tenant joblink.db into multi-tenant structure.
// Creates system.db with orgs + users, copies joblink.db to org-1.db (tenant DB).
//
// Usage: node scripts/migrate-to-multi-tenant.js [--dry-run]
//
// What it does:
// 1. Opens existing data/joblink.db
// 2. Creates data/system.db with orgs table + users table
// 3. Creates org "Default" (id=1) in system.db
// 4. Copies all users from joblink.db's users table to system.db (with org_id=1)
// 5. Copies data/joblink.db to data/org-1.db (the tenant DB)
// 6. Renames data/joblink.db to data/joblink.db.bak (backup)

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { openSystemDb } = require('../src/system-db');
const { openDb } = require('../src/db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DRY_RUN = process.argv.includes('--dry-run');

function log(msg) { console.log(`[migrate] ${msg}`); }

function main() {
  const oldDbPath = path.join(DATA_DIR, 'joblink.db');
  const sysDbPath = path.join(DATA_DIR, 'system.db');
  const tenantDbPath = path.join(DATA_DIR, 'org-1.db');

  // Pre-flight checks
  if (!fs.existsSync(oldDbPath)) {
    log('No data/joblink.db found — nothing to migrate. If this is a fresh install, just start the server.');
    process.exit(0);
  }
  if (fs.existsSync(sysDbPath)) {
    log('data/system.db already exists — migration may have already been run. Aborting to be safe.');
    process.exit(1);
  }
  if (fs.existsSync(tenantDbPath)) {
    log('data/org-1.db already exists — migration may have already been run. Aborting to be safe.');
    process.exit(1);
  }

  log(`Opening old database: ${oldDbPath}`);
  const oldDb = new DatabaseSync(oldDbPath);
  oldDb.exec('PRAGMA journal_mode = WAL;');

  // Read existing users
  let users = [];
  try {
    users = oldDb.prepare('SELECT * FROM users').all();
    log(`Found ${users.length} users in joblink.db`);
  } catch (e) {
    log(`Could not read users table: ${e.message}`);
    log('Proceeding with no users to migrate.');
  }

  if (DRY_RUN) {
    log('[DRY RUN] Would create system.db with Default org and migrate users:');
    for (const u of users) {
      log(`  - ${u.username} (${u.role}) email=${u.email || 'none'}`);
    }
    log(`[DRY RUN] Would copy joblink.db -> org-1.db`);
    log(`[DRY RUN] Would rename joblink.db -> joblink.db.bak`);
    process.exit(0);
  }

  // Step 1: Create system.db
  log('Creating system.db...');
  const sysDb = openSystemDb(sysDbPath);

  // Step 2: Create default org
  log('Creating Default org (id=1)...');
  sysDb.prepare("INSERT INTO orgs (name, slug) VALUES ('Default', 'default')").run();
  const org = sysDb.prepare('SELECT * FROM orgs WHERE slug = ?').get('default');
  log(`  Created org: id=${org.id}, name=${org.name}, slug=${org.slug}`);

  // Step 3: Migrate users to system.db
  log('Migrating users...');
  const insertUser = sysDb.prepare(
    `INSERT INTO users (org_id, username, password_hash, role, email, email_verified, display_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const u of users) {
    try {
      insertUser.run(
        org.id,
        u.username,
        u.password_hash || '',
        u.role || 'recruiter',
        u.email || null,
        u.email_verified || 0,
        u.display_name || '',
        u.created_at || new Date().toISOString(),
      );
      log(`  Migrated user: ${u.username} (${u.role})`);
    } catch (e) {
      log(`  WARN: Could not migrate user ${u.username}: ${e.message}`);
    }
  }

  // Step 4: Copy joblink.db to org-1.db
  log('Copying joblink.db -> org-1.db...');
  // Close the old DB first to ensure WAL is checkpointed
  oldDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  oldDb.close();

  fs.copyFileSync(oldDbPath, tenantDbPath);
  // Also copy WAL/SHM if they exist
  for (const ext of ['-wal', '-shm']) {
    const src = oldDbPath + ext;
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, tenantDbPath + ext);
    }
  }
  log('  Copied.');

  // Step 5: Backup original
  log('Backing up joblink.db -> joblink.db.bak...');
  fs.renameSync(oldDbPath, oldDbPath + '.bak');
  // Move WAL/SHM too
  for (const ext of ['-wal', '-shm']) {
    const src = oldDbPath + ext;
    if (fs.existsSync(src)) {
      fs.renameSync(src, oldDbPath + '.bak' + ext);
    }
  }
  log('  Done.');

  log('');
  log('Migration complete!');
  log(`  System DB: ${sysDbPath} (${users.length} users, 1 org)`);
  log(`  Tenant DB: ${tenantDbPath} (all business data)`);
  log(`  Backup: ${oldDbPath}.bak`);
  log('');
  log('You can now start the server. It will use the multi-tenant structure.');
}

main();
