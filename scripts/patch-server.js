// Add finances.html route to server.js (same auth pattern as dev-dashboard)
const fs = require('fs');
const path = '/root/joblink-v2/server.js';
let code = fs.readFileSync(path, 'utf8');

if (code.includes('finances.html')) {
  console.log('Already patched — skipping');
  process.exit(0);
}

// Add finances route after dev-dashboard route
const devDashboardBlock = `res.sendFile(path.join(__dirname, 'private', 'dev-dashboard.html'));
});`;

const replacement = `res.sendFile(path.join(__dirname, 'private', 'dev-dashboard.html'));
});

app.get('/finances.html', auth.requireAuth, (req, res) => {
  if (!req.user || req.user.org_id !== 1) return res.status(403).send('Forbidden');
  res.sendFile(path.join(__dirname, 'private', 'finances.html'));
});`;

code = code.replace(devDashboardBlock, replacement);

fs.writeFileSync(path, code);
console.log('Patched server.js with finances.html route');
