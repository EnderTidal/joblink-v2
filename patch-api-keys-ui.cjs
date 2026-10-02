// Patch 4: Add API Keys section to admin.html settings page
const fs = require('fs');
const file = '/root/joblink-v2-staging/public/admin.html';
let src = fs.readFileSync(file, 'utf8');

if (src.includes('s-api-keys') || src.includes('generateApiKey')) {
  console.log('✓ API Keys UI already present — skipping');
  process.exit(0);
}

// 1. Add tab button after Settings button in nav
src = src.replace(
  /(<button data-t="settings"[^>]*>Settings<\/button>)/,
  '$1\n    <button data-t="api-keys">API Keys</button>'
);

// 2. Add section HTML after </section> of s-settings
const API_KEYS_SECTION = `
  <section id="s-api-keys">
    <div class="card half">
      <h3 style="margin:0 0 16px;font-size:17px;font-weight:800">API Keys</h3>
      <p class="mut" style="margin-bottom:14px;font-size:.88rem">Use API keys to authenticate Copilot endpoints without a session cookie. Send as <code>Authorization: Bearer &lt;key&gt;</code>.</p>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap">
        <input id="api-key-name" placeholder="Key name (optional)" style="flex:1;min-width:140px;max-width:240px">
        <button class="btn" onclick="generateApiKey()">Generate API Key</button>
      </div>
      <div id="api-keys-list"><p class="mut">Loading...</p></div>
    </div>

    <div id="api-key-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1000;display:flex;align-items:center;justify-content:center">
      <div style="background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:28px 32px;max-width:520px;width:90%;box-shadow:0 8px 40px rgba(0,0,0,.4)">
        <h3 style="margin:0 0 10px;font-size:17px">Your new API key</h3>
        <p style="color:#f59e0b;font-size:.88rem;margin:0 0 14px">Copy this now — it will not be shown again.</p>
        <div style="display:flex;gap:8px;align-items:center;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:10px 14px;font-family:monospace;font-size:.88rem;word-break:break-all">
          <span id="api-key-value" style="flex:1"></span>
          <button class="btn sm ghost" onclick="copyApiKey()">Copy</button>
        </div>
        <div style="margin-top:18px;text-align:right">
          <button class="btn" onclick="closeApiKeyModal()">Done</button>
        </div>
      </div>
    </div>
  </section>
`;

src = src.replace(
  /(<\/section>\s*\n\s*<section id="s-users">)/,
  '</section>\n' + API_KEYS_SECTION + '\n  <section id="s-users">'
);

// 3. Add JS functions before closing </script> or near other api calls
const API_KEYS_JS = `
  async function loadApiKeys() {
    try {
      const r = await api('/api/settings/api-keys');
      const el = document.getElementById('api-keys-list');
      if (!r.keys || r.keys.length === 0) { el.innerHTML = '<p class="mut">No API keys yet.</p>'; return; }
      el.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:.88rem"><thead><tr style="text-align:left;color:var(--muted)"><th style="padding:4px 8px">Name</th><th style="padding:4px 8px">Prefix</th><th style="padding:4px 8px">Created</th><th style="padding:4px 8px">Last used</th><th style="padding:4px 8px"></th></tr></thead><tbody>' +
        r.keys.map(k => '<tr style="border-top:1px solid var(--line)' + (k.revoked_at ? ';opacity:.45' : '') + '"><td style="padding:6px 8px">' + escHtml(k.name) + '</td><td style="padding:6px 8px;font-family:monospace">' + escHtml(k.key_prefix) + '...</td><td style="padding:6px 8px">' + fmtDate(k.created_at) + '</td><td style="padding:6px 8px">' + (k.last_used_at ? fmtDate(k.last_used_at) : '—') + '</td><td style="padding:6px 8px">' + (k.revoked_at ? '<span class="mut">Revoked</span>' : '<button class="btn ghost sm" onclick="revokeApiKey(' + k.id + ')">Revoke</button>') + '</td></tr>').join('') +
        '</tbody></table>';
    } catch { document.getElementById('api-keys-list').innerHTML = '<p class="mut">Failed to load keys.</p>'; }
  }

  function escHtml(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmtDate(s) { try { return new Date(s).toLocaleDateString(); } catch { return s || '—'; } }

  async function generateApiKey() {
    const name = document.getElementById('api-key-name').value.trim() || 'Default';
    try {
      const r = await api('/api/settings/api-key/generate', { method: 'POST', body: { name } });
      document.getElementById('api-key-value').textContent = r.key;
      document.getElementById('api-key-modal').style.display = 'flex';
      await loadApiKeys();
    } catch (e) { alert('Failed: ' + (e.message || 'unknown error')); }
  }

  function copyApiKey() {
    const val = document.getElementById('api-key-value').textContent;
    navigator.clipboard.writeText(val).then(() => alert('Copied!')).catch(() => prompt('Copy this key:', val));
  }

  function closeApiKeyModal() { document.getElementById('api-key-modal').style.display = 'none'; }

  async function revokeApiKey(id) {
    if (!confirm('Revoke this API key? Any integrations using it will stop working.')) return;
    try {
      await api('/api/settings/api-key/' + id, { method: 'DELETE' });
      await loadApiKeys();
    } catch (e) { alert('Failed: ' + (e.message || 'unknown error')); }
  }
`;

// Insert before closing script tag
src = src.replace(
  /(<\/script>)(\s*<\/body>)/,
  API_KEYS_JS + '\n$1$2'
);

// 4. Load API keys when tab is switched to api-keys
src = src.replace(
  /(document\.querySelectorAll\('section'\)\.forEach[\s\S]*?x\.classList\.remove\('on'\)\s*\}[^;]*;)/,
  '$1\n  if (t === \'api-keys\') loadApiKeys();'
);

fs.writeFileSync(file, src);
console.log('✓ API Keys UI added to admin.html');
