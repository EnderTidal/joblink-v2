#!/usr/bin/env node
// migrate-v1.js — Migrate JobLink V1 (PostgreSQL) -> V2 (SQLite per-org)
// Usage: DRY_RUN=true node scripts/migrate-v1.js   (preview only)
//        DRY_RUN=false node scripts/migrate-v1.js   (live migration)
//
// Idempotent: safe to run multiple times. Uses INSERT OR IGNORE / UPDATE logic.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// --- Config ---
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() !== 'false';
const V1_DIR = '/root/joblink';
const V2_DIR = '/root/joblink-v2';
const ORG_DB_PATH = path.join(V2_DIR, 'data', 'org-1.db');
const SYSTEM_DB_PATH = path.join(V2_DIR, 'data', 'system.db');
const BACKUP_PATH = ORG_DB_PATH + '.pre-migration-backup';

// --- Phone normalization (matches V2 src/phone.js exactly) ---
function normalizePhone(input) {
  if (input === null || input === undefined) return null;
  let digits = String(input).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  if (digits[0] === '0' || digits[0] === '1') return null;
  return digits;
}

// --- Name splitting (V1 stores "Last, First" in a single name column) ---
function splitName(name) {
  if (!name) return { first: '', last: '' };
  const parts = name.split(',').map(s => s.trim());
  if (parts.length >= 2) {
    return { first: parts[1], last: parts[0] };
  }
  // No comma -- try space-split, last word is last name
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return { first: words[0], last: '' };
  return { first: words.slice(0, -1).join(' '), last: words[words.length - 1] };
}

// --- V1 skill_type -> V2 category mapping ---
function mapCategory(skillType) {
  if (!skillType) return null;
  const s = skillType.trim();
  if (s === 'Industrial' || s === 'Administrative' || s === 'Skilled Trade') return s;
  if (/industrial/i.test(s)) return 'Industrial';
  if (/admin/i.test(s)) return 'Administrative';
  if (/skilled|trade/i.test(s)) return 'Skilled Trade';
  return null;
}

// --- V1 JO status -> V2 status mapping ---
function mapJOStatus(v1Status) {
  if (!v1Status) return 'Unpublished';
  const s = v1Status.toLowerCase();
  if (s === 'published') return 'Published';
  if (s === 'completed' || s === 'complete') return 'Complete';
  return 'Unpublished';
}

// --- V1 interest status -> V2 status mapping ---
function mapInterestStatus(v1Status) {
  const valid = ['interested', 'yes_listed', 'confirmed', 'filled', 'ruled_out'];
  if (valid.includes(v1Status)) return v1Status;
  return 'interested';
}

// --- Logging ---
const log = {
  info: (msg) => console.log('[INFO]  ' + msg),
  warn: (msg) => console.log('[WARN]  ' + msg),
  error: (msg) => console.error('[ERROR] ' + msg),
  dry: (msg) => console.log('[DRY]   ' + msg),
};

// --- Main ---
async function main() {
  log.info('=== JobLink V1->V2 Migration ===');
  log.info('Mode: ' + (DRY_RUN ? 'DRY RUN (no writes)' : '*** LIVE ***'));
  log.info('Org DB: ' + ORG_DB_PATH);
  log.info('System DB: ' + SYSTEM_DB_PATH);
  log.info('');

  // ---------- BACKUP ----------
  if (!DRY_RUN) {
    log.info('Creating backup: ' + BACKUP_PATH);
    fs.copyFileSync(ORG_DB_PATH, BACKUP_PATH);
    log.info('Backup created.');
  } else {
    log.dry('Would backup ' + ORG_DB_PATH + ' -> ' + BACKUP_PATH);
  }

  // ---------- Connect V1 (PostgreSQL) ----------
  const v1EnvPath = path.join(V1_DIR, '.env');
  const v1Env = fs.readFileSync(v1EnvPath, 'utf8');
  const dbUrlMatch = v1Env.match(/^DATABASE_URL=(.+)$/m);
  if (!dbUrlMatch) throw new Error('DATABASE_URL not found in V1 .env');
  const DATABASE_URL = dbUrlMatch[1].trim();

  const { Client } = require(path.join(V1_DIR, 'node_modules', 'pg'));
  const pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  log.info('Connected to V1 PostgreSQL.');

  // ---------- Open V2 SQLite ----------
  const orgDb = new DatabaseSync(ORG_DB_PATH);
  const sysDb = new DatabaseSync(SYSTEM_DB_PATH);
  log.info('Opened V2 SQLite databases.');

  // Build V2 existing candidates set (by phone)
  const v2Candidates = new Set();
  const v2Rows = orgDb.prepare('SELECT phone FROM candidates').all();
  for (const row of v2Rows) v2Candidates.add(row.phone);
  log.info('V2 existing candidates: ' + v2Candidates.size);

  // Build V2 existing users set (by email)
  const v2Users = new Map();
  const v2UserRows = sysDb.prepare('SELECT id, email FROM users WHERE org_id = 1').all();
  for (const row of v2UserRows) {
    if (row.email) v2Users.set(row.email.toLowerCase(), row.id);
  }
  log.info('V2 existing users (org 1): ' + v2Users.size);

  // ============================================================
  // A) CANDIDATES
  // ============================================================
  log.info('');
  log.info('--- CANDIDATES ---');
  const v1Candidates = (await pg.query(
    'SELECT * FROM joblink_candidates WHERE org_id = 1'
  )).rows;
  log.info('V1 candidates (org 1): ' + v1Candidates.length);

  // Build V1 id->phone map (needed for interests later)
  const v1IdToPhone = new Map();

  const cStats = { inserted: 0, updated: 0, skipped_nophone: 0, skipped_dupephone: 0, errors: 0 };
  const seenPhones = new Set(); // dedup within V1

  // Prepare SQLite statements
  const insertCandidate = orgDb.prepare(
    'INSERT OR IGNORE INTO candidates (phone, first_name, last_name, magic_token, current_category, last_blast, blast_count, do_not_contact, assigned_recruiter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  const updateCandidate = orgDb.prepare(
    'UPDATE candidates SET first_name = ?, last_name = ?, current_category = ?, assigned_recruiter = ?, do_not_contact = ?, magic_token = ? WHERE phone = ?'
  );

  if (!DRY_RUN) orgDb.exec('BEGIN');

  for (const c of v1Candidates) {
    try {
      const phone = normalizePhone(c.cell_phone);
      if (!phone) {
        cStats.skipped_nophone++;
        continue;
      }

      // Store V1 id->phone mapping regardless
      v1IdToPhone.set(c.id, phone);

      if (seenPhones.has(phone)) {
        cStats.skipped_dupephone++;
        continue;
      }
      seenPhones.add(phone);

      const { first: firstName, last: lastName } = splitName(c.name);
      const category = mapCategory(c.skill_type);
      const dnc = (c.status === 'inactive' || c.exclusion_type) ? 1 : 0;
      const magicToken = c.magic_token; // V1 UUID -- these are in the wild via SMS
      const lastBlast = c.last_blasted_at ? new Date(c.last_blasted_at).toISOString() : null;
      const blastCount = c.blast_count || 0;
      const assignedRecruiter = null;
      const createdAt = c.created_at ? new Date(c.created_at).toISOString() : new Date().toISOString();

      if (v2Candidates.has(phone)) {
        // OVERLAP -- update V2 with V1 data, replace token with V1 token (in the wild)
        if (DRY_RUN) {
          if (cStats.updated < 5) {
            log.dry('UPDATE candidate ' + phone + ': ' + firstName + ' ' + lastName + ', cat=' + category + ', dnc=' + dnc + ', token=' + magicToken.substring(0, 8) + '...');
          }
        } else {
          updateCandidate.run(firstName, lastName, category, assignedRecruiter, dnc, magicToken, phone);
        }
        cStats.updated++;
      } else {
        // V1-ONLY -- insert
        if (DRY_RUN) {
          if (cStats.inserted < 5) {
            log.dry('INSERT candidate ' + phone + ': ' + firstName + ' ' + lastName + ', cat=' + category + ', dnc=' + dnc);
          }
        } else {
          insertCandidate.run(phone, firstName, lastName, magicToken, category, lastBlast, blastCount, dnc, assignedRecruiter, createdAt);
        }
        cStats.inserted++;
      }
    } catch (err) {
      cStats.errors++;
      log.error('Candidate id=' + c.id + ' error: ' + err.message);
    }
  }

  if (!DRY_RUN) orgDb.exec('COMMIT');

  log.info('Candidates: inserted=' + cStats.inserted + ', updated=' + cStats.updated + ', skipped_nophone=' + cStats.skipped_nophone + ', skipped_dupephone=' + cStats.skipped_dupephone + ', errors=' + cStats.errors);

  // ============================================================
  // B) JOB ORDERS
  // ============================================================
  log.info('');
  log.info('--- JOB ORDERS ---');
  const v1JOs = (await pg.query(
    'SELECT * FROM joblink_job_orders WHERE org_id = 1 ORDER BY id'
  )).rows;
  log.info('V1 job orders (org 1): ' + v1JOs.length);

  const joIdMap = new Map(); // V1 id -> V2 id
  const joStats = { inserted: 0, skipped: 0, errors: 0 };

  // Check existing V2 JOs by title+company+created_at for idempotency
  const v2JOs = orgDb.prepare('SELECT id, title, company, created_at FROM job_orders').all();
  const v2JOSet = new Map();
  for (const j of v2JOs) {
    v2JOSet.set(j.title + '|||' + j.company + '|||' + j.created_at, j.id);
  }

  const insertJO = orgDb.prepare(
    'INSERT INTO job_orders (title, category, pay, shift_hours, location, requirements, description, company, status, assigned_recruiter, created_at, updated_at, address, city_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  if (!DRY_RUN) orgDb.exec('BEGIN');

  for (const jo of v1JOs) {
    try {
      const title = jo.title || jo.job_title || jo.jo_number || 'Untitled';
      const company = jo.company_name || jo.company || '';
      const createdAt = jo.created_at ? new Date(jo.created_at).toISOString() : new Date().toISOString();
      const key = title + '|||' + company + '|||' + createdAt;

      // Idempotency: skip if already exists
      if (v2JOSet.has(key)) {
        joIdMap.set(jo.id, v2JOSet.get(key));
        joStats.skipped++;
        continue;
      }

      const category = mapCategory(jo.skill_type) || 'Industrial';
      const pay = jo.pay_rate || '';
      const shiftHours = jo.shift || '';
      const location = jo.location || jo.work_location || '';
      const requirements = jo.requirements || jo.skills_required || '';
      const description = jo.description || '';
      const status = mapJOStatus(jo.status);
      const assignedRecruiter = null;
      const updatedAt = jo.updated_at ? new Date(jo.updated_at).toISOString() : createdAt;
      const address = jo.address || '';
      const cityState = jo.city_state || '';

      if (DRY_RUN) {
        if (joStats.inserted < 5) {
          log.dry('INSERT JO: "' + title + '" @ ' + company + ', status=' + status + ', cat=' + category);
        }
        // Simulate auto-increment for dry run mapping
        joIdMap.set(jo.id, 1000 + joStats.inserted);
      } else {
        const result = insertJO.run(title, category, pay, shiftHours, location, requirements, description, company, status, assignedRecruiter, createdAt, updatedAt, address, cityState);
        joIdMap.set(jo.id, Number(result.lastInsertRowid));
      }
      joStats.inserted++;
    } catch (err) {
      joStats.errors++;
      log.error('JO id=' + jo.id + ' error: ' + err.message);
    }
  }

  if (!DRY_RUN) orgDb.exec('COMMIT');

  log.info('Job Orders: inserted=' + joStats.inserted + ', skipped=' + joStats.skipped + ', errors=' + joStats.errors);

  // ============================================================
  // C) INTERESTS
  // ============================================================
  log.info('');
  log.info('--- INTERESTS ---');
  const v1Interests = (await pg.query(
    'SELECT * FROM joblink_job_interest WHERE org_id = 1'
  )).rows;
  log.info('V1 interests (org 1): ' + v1Interests.length);

  const intStats = { inserted: 0, skipped_nophone: 0, skipped_nojo: 0, skipped_dupe: 0, errors: 0 };

  // Build set of existing V2 interests for idempotency
  const v2Interests = new Set();
  const v2IntRows = orgDb.prepare('SELECT phone, job_order_id FROM interests').all();
  for (const r of v2IntRows) v2Interests.add(r.phone + '|||' + r.job_order_id);

  const insertInterest = orgDb.prepare(
    'INSERT OR IGNORE INTO interests (phone, job_order_id, blast_id, status, created_at) VALUES (?, ?, ?, ?, ?)'
  );

  if (!DRY_RUN) orgDb.exec('BEGIN');

  for (const int of v1Interests) {
    try {
      const phone = v1IdToPhone.get(int.candidate_id);
      const v2JoId = joIdMap.get(int.job_order_id);

      if (!phone) {
        intStats.skipped_nophone++;
        continue;
      }
      if (!v2JoId) {
        intStats.skipped_nojo++;
        continue;
      }

      // Idempotency check
      const intKey = phone + '|||' + v2JoId;
      if (v2Interests.has(intKey)) {
        intStats.skipped_dupe++;
        continue;
      }

      const status = mapInterestStatus(int.status);
      const createdAt = int.clicked_at ? new Date(int.clicked_at).toISOString() : new Date().toISOString();

      if (DRY_RUN) {
        if (intStats.inserted < 5) {
          log.dry('INSERT interest: phone=' + phone + ', v2_jo=' + v2JoId + ', status=' + status);
        }
      } else {
        insertInterest.run(phone, v2JoId, null, status, createdAt);
      }
      intStats.inserted++;
    } catch (err) {
      intStats.errors++;
      log.error('Interest id=' + int.id + ' error: ' + err.message);
    }
  }

  if (!DRY_RUN) orgDb.exec('COMMIT');

  log.info('Interests: inserted=' + intStats.inserted + ', skipped_nophone=' + intStats.skipped_nophone + ', skipped_nojo=' + intStats.skipped_nojo + ', skipped_dupe=' + intStats.skipped_dupe + ', errors=' + intStats.errors);

  // ============================================================
  // D) BLASTS
  // ============================================================
  log.info('');
  log.info('--- BLASTS ---');
  const v1Blasts = (await pg.query(
    'SELECT * FROM joblink_batch_blasts WHERE org_id = 1 ORDER BY id'
  )).rows;
  log.info('V1 blasts (org 1): ' + v1Blasts.length);

  const blastStats = { inserted: 0, skipped: 0, errors: 0 };

  // Idempotency: check by sent_at + sent_by
  const v2Blasts = new Set();
  const v2BlastRows = orgDb.prepare('SELECT sent_at, sent_by FROM blasts').all();
  for (const b of v2BlastRows) v2Blasts.add((b.sent_at || '') + '|||' + (b.sent_by || ''));

  const insertBlast = orgDb.prepare(
    'INSERT INTO blasts (sent_at, category, template_id, message_preview, sent_count, skipped_cooldown_count, skipped_dnc_count, failed_count, sent_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  if (!DRY_RUN) orgDb.exec('BEGIN');

  for (const b of v1Blasts) {
    try {
      const sentAt = b.created_at ? new Date(b.created_at).toISOString() : new Date().toISOString();
      const sentBy = b.recruiter_email || b.created_by || '';
      const blastKey = sentAt + '|||' + sentBy;

      if (v2Blasts.has(blastKey)) {
        blastStats.skipped++;
        continue;
      }

      const category = 'Industrial'; // V1 blasts dont have category
      const messagePreview = b.template || '';
      const sentCount = Array.isArray(b.candidate_ids) ? b.candidate_ids.length : 0;

      if (DRY_RUN) {
        log.dry('INSERT blast: sent_at=' + sentAt + ', sent_count=' + sentCount + ', by=' + sentBy);
      } else {
        insertBlast.run(sentAt, category, null, messagePreview, sentCount, 0, 0, 0, sentBy);
      }
      blastStats.inserted++;
    } catch (err) {
      blastStats.errors++;
      log.error('Blast id=' + b.id + ' error: ' + err.message);
    }
  }

  if (!DRY_RUN) orgDb.exec('COMMIT');

  log.info('Blasts: inserted=' + blastStats.inserted + ', skipped=' + blastStats.skipped + ', errors=' + blastStats.errors);

  // ============================================================
  // E) ADMINS -> USERS
  // ============================================================
  log.info('');
  log.info('--- ADMINS -> USERS ---');
  const v1Admins = (await pg.query(
    'SELECT * FROM joblink_admins WHERE org_id = 1'
  )).rows;
  log.info('V1 admins (org 1): ' + v1Admins.length);

  const adminStats = { inserted: 0, skipped: 0, errors: 0 };

  const insertUser = sysDb.prepare(
    'INSERT INTO users (org_id, username, password_hash, role, email, email_verified, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  if (!DRY_RUN) sysDb.exec('BEGIN');

  for (const admin of v1Admins) {
    try {
      const email = (admin.email || '').toLowerCase().trim();
      if (!email) {
        adminStats.skipped++;
        continue;
      }

      if (v2Users.has(email)) {
        if (DRY_RUN) log.dry('SKIP user (exists): ' + email);
        adminStats.skipped++;
        continue;
      }

      const username = email.split('@')[0].replace(/[^a-z0-9._-]/gi, '').toLowerCase();
      const role = admin.role === 'admin' ? 'admin' : 'recruiter';
      const displayName = admin.name || '';
      // Temp password hash -- users will need magic login or reset
      const tempHash = crypto.randomBytes(32).toString('hex');
      const createdAt = admin.created_at ? new Date(admin.created_at).toISOString() : new Date().toISOString();

      if (DRY_RUN) {
        log.dry('INSERT user: ' + email + ' (' + displayName + '), role=' + role + ', username=' + username);
      } else {
        insertUser.run(1, username, tempHash, role, email, 0, displayName, createdAt);
      }
      adminStats.inserted++;
    } catch (err) {
      adminStats.errors++;
      log.error('Admin id=' + admin.id + ' error: ' + err.message);
    }
  }

  if (!DRY_RUN) sysDb.exec('COMMIT');

  log.info('Admins->Users: inserted=' + adminStats.inserted + ', skipped=' + adminStats.skipped + ', errors=' + adminStats.errors);

  // ============================================================
  // SUMMARY
  // ============================================================
  log.info('');
  log.info('========================================');
  log.info('MIGRATION ' + (DRY_RUN ? 'DRY RUN' : 'COMPLETE'));
  log.info('========================================');
  log.info('Candidates: ' + cStats.inserted + ' insert, ' + cStats.updated + ' update, ' + cStats.skipped_nophone + ' skip(no phone), ' + cStats.skipped_dupephone + ' skip(dupe), ' + cStats.errors + ' errors');
  log.info('Job Orders: ' + joStats.inserted + ' insert, ' + joStats.skipped + ' skip, ' + joStats.errors + ' errors');
  log.info('Interests:  ' + intStats.inserted + ' insert, ' + intStats.skipped_nophone + ' skip(no phone), ' + intStats.skipped_nojo + ' skip(no JO), ' + intStats.skipped_dupe + ' skip(dupe), ' + intStats.errors + ' errors');
  log.info('Blasts:     ' + blastStats.inserted + ' insert, ' + blastStats.skipped + ' skip, ' + blastStats.errors + ' errors');
  log.info('Users:      ' + adminStats.inserted + ' insert, ' + adminStats.skipped + ' skip, ' + adminStats.errors + ' errors');
  log.info('');

  if (DRY_RUN) {
    log.info('To run live: DRY_RUN=false node scripts/migrate-v1.js');
  }

  // Cleanup
  await pg.end();
  orgDb.close();
  sysDb.close();
}

main().catch(err => {
  log.error('Fatal: ' + err.message);
  console.error(err.stack);
  process.exit(1);
});
