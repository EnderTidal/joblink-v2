// Tenant DB management — each org gets its own SQLite database.
// Files live at data/org-{id}.db (or DATA_DIR from env). A cache keeps them
// open for the process lifetime. New tenant DBs are created from the same
// schema as a fresh openDb() call.

const path = require('node:path');
const { openDb } = require('./db');

function getDataDir() {
  return process.env.DATA_DIR || path.join(__dirname, '..', 'data');
}

// In-memory cache: orgId -> DatabaseSync instance
const tenantCache = new Map();

/** Get (or open) the tenant DB for a given org. */
function getTenantDb(orgId) {
  if (tenantCache.has(orgId)) return tenantCache.get(orgId);
  const filePath = path.join(getDataDir(), `org-${orgId}.db`);
  const db = openDb(filePath);
  tenantCache.set(orgId, db);
  return db;
}

/** Create a brand-new tenant DB for an org. Returns the opened DB. */
function createTenantDb(orgId) {
  const filePath = path.join(getDataDir(), `org-${orgId}.db`);
  const db = openDb(filePath);
  tenantCache.set(orgId, db);
  return db;
}

/** Check if a tenant DB file exists. */
function tenantDbExists(orgId) {
  const fs = require('node:fs');
  return fs.existsSync(path.join(getDataDir(), `org-${orgId}.db`));
}

/** Close a tenant DB and remove from cache (for cleanup/testing). */
function closeTenantDb(orgId) {
  if (tenantCache.has(orgId)) {
    try { tenantCache.get(orgId).close(); } catch { /* already closed */ }
    tenantCache.delete(orgId);
  }
}

/** Close all cached tenant DBs (for shutdown/testing). */
function closeAllTenantDbs() {
  for (const [orgId] of tenantCache) {
    closeTenantDb(orgId);
  }
}

/** Express middleware: attaches req.db (tenant DB) based on req.user.org_id. */
function tenantMiddleware(req, res, next) {
  if (!req.user || !req.user.org_id) {
    return res.status(401).json({ error: 'no_tenant' });
  }
  try {
    req.db = getTenantDb(req.user.org_id);
    next();
  } catch (err) {
    console.error('[tenant]', err.message);
    res.status(500).json({ error: 'tenant_db_error' });
  }
}

module.exports = {
  getTenantDb, createTenantDb, tenantDbExists,
  closeTenantDb, closeAllTenantDbs, tenantMiddleware,
};
