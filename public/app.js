// Shared page helpers — one copy, every page.
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401 && !location.pathname.endsWith('login.html')) {
    location.href = '/login.html';
    throw new Error('not logged in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function navbar(active) {
  return `<nav class="topbar">
    <span class="brand">JobLink</span>
    <a href="/tom.html" class="${active === 'tom' ? 'active' : ''}">Tom</a>
    <a href="/dashboard.html" class="${active === 'dash' ? 'active' : ''}">Dashboard</a>
    <a href="/admin.html" class="${active === 'admin' ? 'active' : ''}">Admin</a>
    <span class="spacer"></span>
    <span class="mut" id="whoami" style="color:#cfe1f3"></span>
    <button onclick="api('/api/logout',{method:'POST'}).then(()=>location.href='/login.html')">Log out</button>
  </nav>`;
}

async function boot(active) {
  document.body.insertAdjacentHTML('afterbegin', navbar(active));
  try {
    const me = await api('/api/me');
    document.getElementById('whoami').textContent = me.username + (me.role === 'admin' ? ' (admin)' : '');
    return me;
  } catch { /* redirected */ }
}
