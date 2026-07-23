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
    <span class="spacer"></span>
    <div class="nav-links">
      <a href="/dashboard.html" class="${active === 'dash' ? 'active' : ''}">Dashboard</a>
      <a href="/tom.html" class="${active === 'tom' ? 'active' : ''}">AI Assistant</a>
      <a href="/admin.html" class="${active === 'admin' ? 'active' : ''}">Admin</a>
    </div>
    <span class="spacer"></span>
    <span class="mut" id="whoami"></span>
    <button class="theme-toggle" onclick="toggleTheme()" title="Toggle light/dark mode" id="themeBtn">
      <svg id="themeIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
      </svg>
    </button>
    <button onclick="api('/api/logout',{method:'POST'}).then(()=>location.href='/login.html')">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      Log out
    </button>
  </nav>`;
}

async function boot(active) {
  document.body.insertAdjacentHTML('afterbegin', navbar(active));
  try {
    const me = await api('/api/me');
    document.getElementById('whoami').textContent = (me.display_name || me.username) + (me.role === 'admin' ? ' (admin)' : '');
    return me;
  } catch { /* redirected */ }
}


/* Theme toggle — dark default, light opt-in */
function toggleTheme() {
  var isLight = document.documentElement.classList.toggle('light-mode');
  localStorage.setItem('joblink_light_mode', isLight ? 'true' : 'false');
  updateThemeIcon();
}
function updateThemeIcon() {
  var icon = document.getElementById('themeIcon');
  if (!icon) return;
  var isLight = document.documentElement.classList.contains('light-mode');
  icon.innerHTML = isLight
    ? '<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>'
    : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>';
}
// Update icon after navbar renders
document.addEventListener('DOMContentLoaded', updateThemeIcon);
