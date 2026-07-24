// E2E Smoke Test for JobLink V2
// Hits every critical route on localhost:3849 with HTTP requests.
// Reports pass/fail with details. Exit 0 if all pass, 1 if any fail.
// Called by deploy.sh after PM2 restart.

const http = require('http');

const PORT = process.env.PORT || 3849;
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = 10000;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      timeout: TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: data,
      }));
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const tests = [
  {
    name: 'GET /health → 200, JSON with status:"ok"',
    run: async () => {
      const res = await request('GET', '/health');
      if (res.status !== 200) return `Expected 200, got ${res.status}`;
      const json = JSON.parse(res.body);
      if (json.status !== 'ok') return `Expected status:"ok", got "${json.status}"`;
      return null;
    },
  },
  {
    name: 'GET /login.html → 200, contains "JobLink"',
    run: async () => {
      const res = await request('GET', '/login.html');
      if (res.status !== 200) return `Expected 200, got ${res.status}`;
      if (!res.body.includes('JobLink')) return 'Response does not contain "JobLink"';
      return null;
    },
  },
  {
    name: 'POST /api/login with bad creds → 401',
    run: async () => {
      const res = await request('POST', '/api/login', { username: 'fake', password: 'wrong' });
      if (res.status !== 401) return `Expected 401, got ${res.status}`;
      return null;
    },
  },
  {
    name: 'GET /m/preview?org=1 → 200, contains "Preview"',
    run: async () => {
      const res = await request('GET', '/m/preview');
      if (res.status !== 200) return `Expected 200, got ${res.status}`;
      if (!res.body.toLowerCase().includes('preview')) return 'Response does not contain "Preview"';
      return null;
    },
  },
  {
    name: 'GET /tom.html → 200 (static page served)',
    run: async () => {
      const res = await request('GET', '/tom.html');
      if (res.status !== 200) return `Expected 200, got ${res.status}`;
      return null;
    },
  },
  {
    name: 'GET /admin.html → 200 (static page served)',
    run: async () => {
      const res = await request('GET', '/admin.html');
      if (res.status !== 200) return `Expected 200, got ${res.status}`;
      return null;
    },
  },
  {
    name: 'GET /dashboard.html → 200 (static page served)',
    run: async () => {
      const res = await request('GET', '/dashboard.html');
      if (res.status !== 200) return `Expected 200, got ${res.status}`;
      return null;
    },
  },
];

async function main() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const test of tests) {
    try {
      const err = await test.run();
      if (err) {
        failed++;
        failures.push({ name: test.name, error: err });
        console.log(`  \u2717 ${test.name}`);
        console.log(`    \u2192 ${err}`);
      } else {
        passed++;
        console.log(`  \u2713 ${test.name}`);
      }
    } catch (e) {
      failed++;
      failures.push({ name: test.name, error: e.message });
      console.log(`  \u2717 ${test.name}`);
      console.log(`    \u2192 ${e.message}`);
    }
  }

  console.log(`\nE2E Smoke: ${passed}/${tests.length} passed`);

  if (failed > 0) {
    console.log(`\n${failed} FAILURE(S):`);
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Smoke test crashed:', e.message);
  process.exit(1);
});
