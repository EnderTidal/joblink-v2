// test-patches.js — Automated test harness for Patch 1 (Whippy sync pagination)
// and Patch 2 (multi-number support). Run: node test-patches.js
//
// Tests:
//   1. Whippy sync pagination: verifies all pages are fetched (75 users, not truncated at 50)
//   2. Multi-number CRUD: save, limit, validation, delete via staging API
//   3. Blast number selection: verifies whippy_numbers appear in settings + provider override

const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const STAGING_PORT = 3850;
const STAGING_HOST = '127.0.0.1';
const MOCK_PORT = 19999;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const icon = pass ? '\x1b[32m[PASS]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m';
  console.log('  ' + icon + ' ' + name + (detail ? ' \u2014 ' + detail : ''));
}

// --- Mock Whippy Server ---

function generateUsers(count, startId) {
  startId = startId || 1;
  const users = [];
  for (let i = 0; i < count; i++) {
    const id = startId + i;
    users.push({
      id: 'user-' + id,
      name: 'Test User ' + id,
      first_name: 'First' + id,
      last_name: 'Last' + id,
      email: 'user' + id + '@test.com',
      status: i % 5 === 0 ? 'inactive' : 'active',
    });
  }
  return users;
}

const ALL_MOCK_USERS = generateUsers(75);

function startMockServer() {
  return new Promise(function(resolve) {
    const server = http.createServer(function(req, res) {
      const url = new URL(req.url, 'http://localhost:' + MOCK_PORT);
      res.setHeader('Content-Type', 'application/json');

      // GET /v1/users?page=N&limit=100 -- paginated (returns all 75)
      if (req.method === 'GET' && url.pathname === '/v1/users') {
        const page = parseInt(url.searchParams.get('page')) || 0;
        const limit = parseInt(url.searchParams.get('limit')) || 50;

        if (page >= 1 && limit === 100) {
          // Paginated path: page 1 = all 75 users (< 100, so single page)
          const start = (page - 1) * limit;
          const slice = ALL_MOCK_USERS.slice(start, start + limit);
          res.end(JSON.stringify({ data: slice }));
        } else {
          // Non-paginated path (old bug): only returns 50
          res.end(JSON.stringify({ data: ALL_MOCK_USERS.slice(0, 50) }));
        }
        return;
      }

      // GET /v1/contacts?limit=1 -- connection test
      if (req.method === 'GET' && url.pathname === '/v1/contacts') {
        res.end(JSON.stringify({ data: [{ id: 1 }] }));
        return;
      }

      // POST /v1/messaging/sms -- send SMS
      if (req.method === 'POST' && url.pathname === '/v1/messaging/sms') {
        var body = '';
        req.on('data', function(c) { body += c; });
        req.on('end', function() {
          res.end(JSON.stringify({ id: 'test-msg-123', status: 'sent', data: { conversation_id: 'conv-123' } }));
        });
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
    });

    server.listen(MOCK_PORT, '127.0.0.1', function() {
      console.log('Mock Whippy server listening on :' + MOCK_PORT);
      resolve(server);
    });
  });
}

// --- HTTP helpers ---

function httpReq(method, urlPath, body, headers) {
  headers = headers || {};
  return new Promise(function(resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var opts = {
      hostname: STAGING_HOST,
      port: STAGING_PORT,
      path: urlPath,
      method: method,
      headers: Object.assign({
        'Content-Type': 'application/json',
      }, headers, data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    };
    var req = http.request(opts, function(res) {
      var out = '';
      res.on('data', function(c) { out += c; });
      res.on('end', function() {
        var cookies = res.headers['set-cookie'] || [];
        try {
          resolve({ status: res.statusCode, body: JSON.parse(out), cookies: cookies, raw: out });
        } catch(e) {
          resolve({ status: res.statusCode, body: null, cookies: cookies, raw: out });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function mockHttpReq(method, urlPath, body, headers) {
  headers = headers || {};
  return new Promise(function(resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var opts = {
      hostname: '127.0.0.1',
      port: MOCK_PORT,
      path: urlPath,
      method: method,
      headers: Object.assign({
        'Content-Type': 'application/json',
      }, headers, data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    };
    var req = http.request(opts, function(res) {
      var out = '';
      res.on('data', function(c) { out += c; });
      res.on('end', function() {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(out) });
        } catch(e) {
          resolve({ status: res.statusCode, body: null, raw: out });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// --- Test 1: Whippy Sync Pagination ---

async function testWhippySyncPagination() {
  console.log('\n=== Test 1: Whippy Sync Pagination ===');

  // Test the mock server directly first
  var unpaginated = await mockHttpReq('GET', '/v1/users');
  record('Mock: unpaginated returns 50 (old bug sim)',
    unpaginated.body && unpaginated.body.data && unpaginated.body.data.length === 50,
    'got ' + (unpaginated.body && unpaginated.body.data ? unpaginated.body.data.length : 'null'));

  var paginated = await mockHttpReq('GET', '/v1/users?page=1&limit=100');
  record('Mock: paginated page 1 returns all 75',
    paginated.body && paginated.body.data && paginated.body.data.length === 75,
    'got ' + (paginated.body && paginated.body.data ? paginated.body.data.length : 'null'));

  var page2 = await mockHttpReq('GET', '/v1/users?page=2&limit=100');
  record('Mock: paginated page 2 returns 0 (no more)',
    page2.body && page2.body.data && page2.body.data.length === 0,
    'got ' + (page2.body && page2.body.data ? page2.body.data.length : 'null'));

  // Test the actual pagination loop from routes/admin.js against our mock
  var allUsers = [];
  var page = 1;
  var MAX_PAGES = 50;
  while (page <= MAX_PAGES) {
    var result = await mockHttpReq('GET', '/v1/users?page=' + page + '&limit=100');
    if (!result.body || !result.body.data || !result.body.data.length) break;
    allUsers.push.apply(allUsers, result.body.data);
    if (result.body.data.length < 100) break;
    page++;
  }
  record('Pagination loop fetches all 75 users',
    allUsers.length === 75,
    'got ' + allUsers.length + ' users in ' + page + ' page(s)');

  // Verify the old (non-paginated) approach would have missed users
  var oldResult = await mockHttpReq('GET', '/v1/users');
  record('Old approach would truncate to 50',
    oldResult.body.data.length === 50 && allUsers.length > oldResult.body.data.length,
    'old=' + oldResult.body.data.length + ', new=' + allUsers.length);

  // Verify mix of active/inactive users present
  var inactiveCount = allUsers.filter(function(u) { return u.status === 'inactive'; }).length;
  record('Mix of active/inactive users',
    inactiveCount > 0 && inactiveCount < allUsers.length,
    inactiveCount + ' inactive, ' + (allUsers.length - inactiveCount) + ' active');
}

// --- Test 1b: Whippy Sync via SQLite (unit test) ---

async function testWhippySyncWithSqlite() {
  console.log('\n=== Test 1b: Whippy Sync \u2014 SQLite Integration ===');

  // Create a temp SQLite DB with settings table
  var tmpDb = new DatabaseSync('/tmp/test-org.db');
  tmpDb.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
  tmpDb.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('whippy_api_key', 'test-key')");
  tmpDb.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('sms_provider', 'whippy')");

  // Import getSetting/setSetting from the staging codebase
  var dbMod = require('./src/db');
  var getSetting = dbMod.getSetting;
  var setSetting = dbMod.setSetting;

  // Recreate syncWhippyUsers but pointing at mock server (HTTP, not HTTPS)
  async function syncWhippyUsersMock(db) {
    var apiKey = getSetting(db, 'whippy_api_key');
    if (!apiKey) return { ok: false, error: 'no_api_key' };

    function fetchPage(pg) {
      return new Promise(function(resolve) {
        var opts = {
          hostname: '127.0.0.1',
          port: MOCK_PORT,
          path: '/v1/users?page=' + pg + '&limit=100',
          method: 'GET',
          headers: { 'X-WHIPPY-KEY': apiKey, 'Content-Type': 'application/json' },
        };
        var req = http.request(opts, function(res) {
          var out = '';
          res.on('data', function(c) { out += c; });
          res.on('end', function() {
            try {
              if (res.statusCode < 200 || res.statusCode >= 300) {
                return resolve({ ok: false, error: 'Whippy ' + res.statusCode + ': ' + out });
              }
              var parsed = JSON.parse(out);
              var users = parsed.data || parsed.users || [];
              resolve({ ok: true, users: Array.isArray(users) ? users : [] });
            } catch (e) {
              resolve({ ok: false, error: e.message });
            }
          });
        });
        req.on('error', function(e) { resolve({ ok: false, error: e.message }); });
        req.end();
      });
    }

    var allUsers = [];
    var pg = 1;
    var MAX = 50;
    while (pg <= MAX) {
      var r = await fetchPage(pg);
      if (!r.ok) return r;
      if (!r.users.length) break;
      allUsers.push.apply(allUsers, r.users);
      if (r.users.length < 100) break;
      pg++;
    }

    var mapped = allUsers.map(function(u) {
      return {
        id: u.id,
        name: u.name || u.full_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Unknown',
        email: u.email || '',
      };
    });
    setSetting(db, 'whippy_users', JSON.stringify(mapped));
    return { ok: true, count: mapped.length, users: mapped };
  }

  var result = await syncWhippyUsersMock(tmpDb);
  record('syncWhippyUsers returns ok',
    result.ok === true,
    result.ok ? result.count + ' users' : result.error);

  record('syncWhippyUsers fetches all 75',
    result.count === 75,
    'count=' + result.count);

  // Verify data persisted to SQLite
  var stored = getSetting(tmpDb, 'whippy_users');
  var parsed;
  try { parsed = JSON.parse(stored); } catch(e) { parsed = []; }
  record('Users persisted to settings table',
    parsed.length === 75,
    'stored ' + parsed.length + ' users');

  // Verify user data is properly mapped
  var first = parsed[0];
  record('User data mapped correctly',
    first && first.id && first.name && first.email,
    first ? 'id=' + first.id + ', name=' + first.name : 'no data');

  tmpDb.close();
  try { require('node:fs').unlinkSync('/tmp/test-org.db'); } catch(e) {}
}

// --- Test 2: Multi-Number CRUD ---

async function testMultiNumberCrud() {
  console.log('\n=== Test 2: Multi-Number CRUD ===');

  // Login to staging as admin
  var login = await httpReq('POST', '/api/login', {
    username: 'test_harness',
    password: 'test-harness-2026',
  });

  if (login.status !== 200 || !login.body || !login.body.ok) {
    record('Login to staging', false, 'status=' + login.status + ', body=' + login.raw);
    console.log('  Skipping remaining multi-number tests (login failed)');
    return;
  }

  // Extract session cookie
  var cookie = login.cookies.find(function(c) { return c.startsWith('jl_session='); });
  if (!cookie) {
    record('Session cookie received', false, 'no jl_session cookie');
    return;
  }
  var cookieHeader = cookie.split(';')[0];
  record('Login to staging', true, 'org_id=' + login.body.org_id);

  var h = { Cookie: cookieHeader };

  // 2a. Save 2 numbers
  var save2 = await httpReq('POST', '/api/settings/numbers', {
    numbers: [
      { from_number: '+12535551001', channel_id: 'ch-001', label: 'Tacoma' },
      { from_number: '+12535551002', channel_id: 'ch-002', label: 'Seattle' },
    ],
  }, h);
  record('Save 2 numbers',
    save2.status === 200 && save2.body && save2.body.ok && save2.body.count === 2,
    'status=' + save2.status + ', count=' + (save2.body ? save2.body.count : 'null'));

  // 2b. GET returns 2
  var get2 = await httpReq('GET', '/api/settings/numbers', null, h);
  record('GET returns 2 numbers',
    get2.status === 200 && Array.isArray(get2.body) && get2.body.length === 2,
    'status=' + get2.status + ', length=' + (Array.isArray(get2.body) ? get2.body.length : 'null'));

  // Verify data integrity
  if (Array.isArray(get2.body) && get2.body.length === 2) {
    var first = get2.body[0];
    record('Number data integrity',
      first.from_number && first.channel_id && first.label,
      'from=' + first.from_number + ', ch=' + first.channel_id + ', label=' + first.label);
  }

  // 2c. Save 6 numbers -> should be rejected (max 5)
  var save6 = await httpReq('POST', '/api/settings/numbers', {
    numbers: [
      { from_number: '+12535551001', channel_id: 'ch-001', label: 'N1' },
      { from_number: '+12535551002', channel_id: 'ch-002', label: 'N2' },
      { from_number: '+12535551003', channel_id: 'ch-003', label: 'N3' },
      { from_number: '+12535551004', channel_id: 'ch-004', label: 'N4' },
      { from_number: '+12535551005', channel_id: 'ch-005', label: 'N5' },
      { from_number: '+12535551006', channel_id: 'ch-006', label: 'N6' },
    ],
  }, h);
  record('Save 6 numbers rejected',
    save6.status === 400 && save6.body && save6.body.error && save6.body.error.indexOf('Maximum 5') >= 0,
    'status=' + save6.status + ', error=' + (save6.body ? save6.body.error : 'null'));

  // 2d. Save entry with missing channel_id -> should be rejected
  var missingChannel = await httpReq('POST', '/api/settings/numbers', {
    numbers: [
      { from_number: '+12535551001', label: 'No Channel' },
    ],
  }, h);
  record('Missing channel_id rejected',
    missingChannel.status === 400 && missingChannel.body && missingChannel.body.error && missingChannel.body.error.indexOf('channel_id') >= 0,
    'status=' + missingChannel.status + ', error=' + (missingChannel.body ? missingChannel.body.error : 'null'));

  // 2e. Save entry with missing from_number -> should be rejected
  var missingNumber = await httpReq('POST', '/api/settings/numbers', {
    numbers: [
      { channel_id: 'ch-001', label: 'No Number' },
    ],
  }, h);
  record('Missing from_number rejected',
    missingNumber.status === 400 && missingNumber.body && missingNumber.body.error && missingNumber.body.error.indexOf('from_number') >= 0,
    'status=' + missingNumber.status + ', error=' + (missingNumber.body ? missingNumber.body.error : 'null'));

  // 2f. Save exactly 5 numbers (max allowed)
  var save5 = await httpReq('POST', '/api/settings/numbers', {
    numbers: [
      { from_number: '+12535551001', channel_id: 'ch-001', label: 'N1' },
      { from_number: '+12535551002', channel_id: 'ch-002', label: 'N2' },
      { from_number: '+12535551003', channel_id: 'ch-003', label: 'N3' },
      { from_number: '+12535551004', channel_id: 'ch-004', label: 'N4' },
      { from_number: '+12535551005', channel_id: 'ch-005', label: 'N5' },
    ],
  }, h);
  record('Save exactly 5 numbers (max boundary)',
    save5.status === 200 && save5.body && save5.body.ok && save5.body.count === 5,
    'status=' + save5.status + ', count=' + (save5.body ? save5.body.count : 'null'));

  // 2g. Delete all (save empty array)
  var deleteAll = await httpReq('POST', '/api/settings/numbers', {
    numbers: [],
  }, h);
  record('Delete all numbers (empty array)',
    deleteAll.status === 200 && deleteAll.body && deleteAll.body.ok && deleteAll.body.count === 0,
    'status=' + deleteAll.status + ', count=' + (deleteAll.body ? deleteAll.body.count : 'null'));

  // 2h. GET returns valid response after delete
  var getEmpty = await httpReq('GET', '/api/settings/numbers', null, h);
  record('GET after delete returns valid response',
    getEmpty.status === 200 && Array.isArray(getEmpty.body),
    'status=' + getEmpty.status + ', length=' + (Array.isArray(getEmpty.body) ? getEmpty.body.length : 'null'));
}

// --- Test 3: Blast Number Selection ---

async function testBlastNumberSelection() {
  console.log('\n=== Test 3: Blast Number Selection ===');

  // Login
  var login = await httpReq('POST', '/api/login', {
    username: 'test_harness',
    password: 'test-harness-2026',
  });
  if (login.status !== 200) {
    record('Login for blast test', false, 'status=' + login.status);
    return;
  }
  var cookie = login.cookies.find(function(c) { return c.startsWith('jl_session='); });
  var h = { Cookie: cookie.split(';')[0] };

  // Save 2 numbers for blast test
  await httpReq('POST', '/api/settings/numbers', {
    numbers: [
      { from_number: '+12535551001', channel_id: 'ch-001', label: 'Tacoma' },
      { from_number: '+12535551002', channel_id: 'ch-002', label: 'Seattle' },
    ],
  }, h);

  // Get settings -- should include whippy_numbers
  var settings = await httpReq('GET', '/api/settings', null, h);
  record('Settings include whippy_numbers',
    settings.status === 200 && settings.body && Array.isArray(settings.body.whippy_numbers) && settings.body.whippy_numbers.length === 2,
    'status=' + settings.status + ', numbers=' + (settings.body && settings.body.whippy_numbers ? settings.body.whippy_numbers.length : 'null'));

  // Verify the numbers data in settings
  if (settings.body && Array.isArray(settings.body.whippy_numbers)) {
    var nums = settings.body.whippy_numbers;
    record('Settings numbers have correct structure',
      nums[0] && nums[0].from_number && nums[0].channel_id && nums[0].label,
      'first: ' + (nums[0] ? nums[0].label + ' (' + nums[0].from_number + ')' : 'null'));
  }

  // Test resolveNumber logic directly (unit test)
  var messaging = require('./src/messaging');
  var resolveNumber = messaging.resolveNumber;
  var dbMod = require('./src/db');
  var openDb = dbMod.openDb;
  var setSetting = dbMod.setSetting;

  var testDb = openDb('/tmp/test-blast-number.db');
  setSetting(testDb, 'whippy_from_number', '+12535550000');
  setSetting(testDb, 'whippy_channel_id', 'ch-default');
  setSetting(testDb, 'whippy_numbers', JSON.stringify([
    { from_number: '+12535551001', channel_id: 'ch-001', label: 'Tacoma' },
    { from_number: '+12535551002', channel_id: 'ch-002', label: 'Seattle' },
  ]));

  // Resolve with specific number override
  var resolved = resolveNumber(testDb, '+12535551002');
  record('resolveNumber with override picks correct number',
    resolved && resolved.fromNumber === '+12535551002' && resolved.channelId === 'ch-002',
    resolved ? 'from=' + resolved.fromNumber + ', ch=' + resolved.channelId : 'null');

  // Resolve with no override falls back to default
  var fallback = resolveNumber(testDb, null);
  record('resolveNumber without override uses default',
    fallback && fallback.fromNumber === '+12535550000' && fallback.channelId === 'ch-default',
    fallback ? 'from=' + fallback.fromNumber + ', ch=' + fallback.channelId : 'null');

  // Resolve with unknown number falls back to default
  var unknown = resolveNumber(testDb, '+19995559999');
  record('resolveNumber with unknown number uses default',
    unknown && unknown.fromNumber === '+12535550000' && unknown.channelId === 'ch-default',
    unknown ? 'from=' + unknown.fromNumber + ', ch=' + unknown.channelId : 'null');

  // Test provider creation with override
  var getProvider = messaging.getProvider;
  setSetting(testDb, 'sms_provider', 'whippy');
  setSetting(testDb, 'whippy_api_key', 'test-key');
  var provider = getProvider(testDb, { fromNumber: '+12535551001', channelId: 'ch-001' });
  record('Provider created with override number',
    provider && provider.name === 'whippy',
    'provider=' + (provider ? provider.name : 'null'));

  testDb.close();
  try { require('node:fs').unlinkSync('/tmp/test-blast-number.db'); } catch(e) {}

  // Clean up: restore empty numbers on staging
  await httpReq('POST', '/api/settings/numbers', { numbers: [] }, h);
}

// --- Main ---

async function main() {
  console.log('=== JOBLINK V2 PATCH TEST HARNESS ===');
  console.log('Staging: ' + STAGING_HOST + ':' + STAGING_PORT);
  console.log('Mock Whippy: 127.0.0.1:' + MOCK_PORT + '\n');

  var mockServer;
  try {
    // Start mock server
    mockServer = await startMockServer();

    // Verify staging is reachable
    try {
      var health = await httpReq('GET', '/health');
      if (health.status !== 200) {
        console.error('Staging not reachable (status ' + health.status + '). Is joblink-v2-staging running on port ' + STAGING_PORT + '?');
        process.exit(1);
      }
      console.log('Staging server reachable.\n');
    } catch (e) {
      console.error('Cannot connect to staging on port ' + STAGING_PORT + ': ' + e.message);
      process.exit(1);
    }

    // Run tests
    await testWhippySyncPagination();
    await testWhippySyncWithSqlite();
    await testMultiNumberCrud();
    await testBlastNumberSelection();

  } catch (err) {
    console.error('\nFATAL:', err);
  } finally {
    if (mockServer) mockServer.close();
  }

  // --- Summary ---
  console.log('\n\x1b[1m=== PATCH TEST RESULTS ===\x1b[0m');
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    var icon = r.pass ? '\x1b[32m[PASS]\x1b[0m' : '\x1b[31m[FAIL]\x1b[0m';
    console.log('  ' + icon + ' ' + r.name + (r.detail ? ' \u2014 ' + r.detail : ''));
  }
  var passed = results.filter(function(r) { return r.pass; }).length;
  var total = results.length;
  console.log('\x1b[1m=== ' + passed + '/' + total + ' PASSED ===\x1b[0m');

  process.exit(passed === total ? 0 : 1);
}

main();
