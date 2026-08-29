// The magic link page — what a candidate sees at /m/<token>.
// Server-rendered, phone-first, zero build step. Shows every PUBLISHED job
// order in the candidate's current category (most recent blast wins), with
// an "I'm Interested" button per job. No PII in the URL — just the token.

const { publishedInCategory } = require('./job-orders');
const { logInterestEvent } = require('./db');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escNl(s) { return esc(s).replace(/\n/g, "<br>"); }
function markInterest(db, candidate, jobOrderId) {
  const jo = db.prepare(`SELECT * FROM job_orders WHERE id = ? AND status = 'Published'`).get(jobOrderId);
  if (!jo) return { ok: false, error: 'job_not_available' };
  // Attribute the interest to the blast that brought them in: their latest blast
  const blast = db.prepare(
    `SELECT b.id FROM blasts b JOIN blast_recipients br ON br.blast_id = b.id
     WHERE br.phone = ? AND br.status = 'sent' ORDER BY b.id DESC LIMIT 1`,
  ).get(candidate.phone);
  // Check if already exists (INSERT OR IGNORE won't tell us)
  const existing = db.prepare('SELECT id FROM interests WHERE phone = ? AND job_order_id = ?').get(candidate.phone, jobOrderId);
  if (!existing) {
    db.prepare(
      'INSERT OR IGNORE INTO interests (phone, job_order_id, blast_id) VALUES (?, ?, ?)',
    ).run(candidate.phone, jobOrderId, blast ? blast.id : null);
    // Log the new interest event
    logInterestEvent(db, candidate.phone, jobOrderId, null, 'interested', 'candidate');
  }
  return { ok: true };
}

function renderCandidatePage(db, candidate, orgName) {
  const category = candidate.current_category;
  const jobs = category ? publishedInCategory(db, category) : [];
  const interested = new Set(
    db.prepare('SELECT job_order_id FROM interests WHERE phone = ?').all(candidate.phone).map((r) => r.job_order_id),
  );

  const jobCards = jobs.map((jo) => {
    const done = interested.has(jo.id);
    return `
    <div class="card" id="job-${jo.id}" data-title-es="${esc(jo.title_es || '')}" data-desc-es="${esc(jo.description_es || '')}" data-req-es="${esc(jo.requirements_es || '')}">
      <h2>${esc(jo.title)}</h2>
      <div class="meta">
        ${jo.pay ? `<span class="chip pay">\u{1F4B5} ${esc(jo.pay)}</span>` : ''}
        ${jo.shift_hours ? `<span class="chip">\u{1F550} ${esc(jo.shift_hours)}</span>` : ''}
        ${jo.city_state ? `<span class="chip">\u{1F4CD} ${esc(jo.city_state)}</span>` : ''}
      </div>
      ${jo.description ? `<p class="req"><strong>Description:</strong> ${escNl(jo.description)}</p>` : ''}
      ${jo.requirements ? `<p class="req"><strong>Requirements:</strong> ${esc(jo.requirements)}</p>` : ''}
      <button class="interest ${done ? 'done' : ''}" data-id="${jo.id}" >
        ${done ? "\u2713 Interest Submitted" : "I'm Interested ✋"}
      </button>
    </div>`;
  }).join('\n');

  const empty = `<div class="card empty"><h2>No open positions right now</h2>
    <p>Check back soon \u2014 new jobs are posted all the time.</p></div>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<title>Jobs for you \u2014 ${esc(orgName || "JobLink")}</title>
<style>
  :root { --brand:#3d4ee6; --blue:#2563eb; --green:#10863f; --amber:#b26a06; --surface:#ffffff; --surface-2:#f6f8fc; --border:#e5e9f2; --text:#0f1728; --text-muted:#59617a; --radius:14px; --radius-sm:10px; --shadow-sm:0 1px 2px rgba(16,24,40,.05); }
  * { box-sizing:border-box; margin:0; }
  body { font-family:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif; background:#eef1f8; color:var(--text); padding-bottom:40px; }
  header { background:var(--brand); color:#fff; padding:20px 16px; text-align:center; position:relative; }
  header h1 { font-size:1.25rem; }
  header p { opacity:.9; font-size:.9rem; margin-top:4px; }
  main { max-width:560px; margin:0 auto; padding:16px; }
  .card { background:var(--surface); border-radius:var(--radius); padding:18px; margin-bottom:14px; box-shadow:var(--shadow-sm); }
  .card h2 { font-size:1.1rem; color:var(--brand); margin-bottom:8px; }
  .meta { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
  .chip { background:var(--surface-2); border-radius:99px; padding:4px 10px; font-size:.82rem; }
  .chip.pay { background:#dcf3e5; font-weight:600; }
  .req { font-size:.9rem; margin-bottom:8px; }
  p { font-size:.92rem; line-height:1.45; }
  .interest { width:100%; margin-top:12px; padding:13px; border:0; border-radius:var(--radius-sm); background:var(--brand);
    color:#ffffff; font-size:1rem; font-weight:700; cursor:pointer; }
  .interest:active { transform:scale(0.98); }
  .interest.done { background:var(--green); color:#fff; }
  .empty { text-align:center; padding:40px 18px; }
  .cat { text-align:center; font-size:.85rem; color:var(--text-muted); margin:4px 0 12px; }
  header { position:relative; }
  .lang-row { text-align:center; padding:10px 0 2px; }
  .lang-pill { display:inline-flex; border-radius:99px; overflow:hidden; border:2px solid rgba(255,255,255,0.7); background:rgba(0,0,0,0.2); backdrop-filter:blur(8px); }
  .lang-pill button { padding:8px 16px; border:none; font-size:14px; font-weight:700; cursor:pointer; background:transparent; color:rgba(255,255,255,0.8); transition:background .15s; }
  .lang-pill button.active { background:rgba(255,255,255,0.35); color:#fff; }
  .translating { opacity:0.5; pointer-events:none; transition:opacity .2s; }
</style></head>
<body>
<header>
  <h1>Hi ${esc(candidate.first_name || 'there')}! \u{1F44B}</h1>
  <p>These jobs are open right now \u2014 tap any you'd like to be considered for.</p>
  <div class="lang-row"><div class="lang-pill"><button id="langEN" class="active" onclick="setLang('en')">EN</button><button id="langES" onclick="setLang('es')">ES</button></div></div>
</header>
<main>
  ${category ? `<div class="cat">${esc(category)} positions</div>` : ''}
  ${jobs.length ? jobCards : empty}
</main>
<script>
var _cache = {};
var _orig = {};
var _lang = 'en';

function _hashJobs() {
  var ids = [];
  document.querySelectorAll('.card:not(.empty)').forEach(function(c) { if (c.id) ids.push(c.id); });
  return ids.join(',');
}

function _captureOrig() {
  if (Object.keys(_orig).length) return;
  _orig._headerH1 = document.querySelector('header h1') ? document.querySelector('header h1').textContent : '';
  _orig._headerP = document.querySelector('header p') ? document.querySelector('header p').textContent : '';
  document.querySelectorAll('.card:not(.empty)').forEach(function(card) {
    if (!card.id) return;
    var o = { title: '', reqs: [], btn: '', badges: [] };
    var h2 = card.querySelector('h2'); if (h2) o.title = h2.textContent;
    card.querySelectorAll('.badge').forEach(function(b) { o.badges.push(b.textContent); });
    card.querySelectorAll('.req').forEach(function(el) { o.reqs.push(el.innerHTML); });
    var btn = card.querySelector('.interest'); if (btn) o.btn = btn.textContent.trim();
    _orig[card.id] = o;
  });
}

function setLang(lang) {
  try { localStorage.setItem('joblink_lang', lang); } catch(e) {}
  _lang = lang;
  document.getElementById('langEN').classList.toggle('active', lang === 'en');
  document.getElementById('langES').classList.toggle('active', lang === 'es');
  _captureOrig();
  if (lang === 'en') { _restoreEN(); return; }
  // Translate header
  var hh = document.querySelector('header h1');
  if (hh) { var n = hh.textContent.match(/Hi (.+)!/); hh.textContent = (n && n[1] !== 'there') ? '\u00a1Hola ' + n[1] + '! \u{1F44B}' : '\u00a1Hola! \u{1F44B}'; }
  var hp = document.querySelector('header p');
  if (hp) hp.textContent = 'Estos trabajos est\u00e1n disponibles ahora \u2014 toca cualquiera que te interese.';
  // Translate filter
  var filterLabel = document.querySelector('label[for="categoryFilter"]');
  if (filterLabel) filterLabel.textContent = 'Ver como:';
  var catSelect = document.getElementById('categoryFilter');
  if (catSelect) { Array.from(catSelect.options).forEach(function(o) {
    if (o.value === '') o.textContent = 'Todas las Categor\u00edas';
    else if (o.value === 'Industrial') o.textContent = 'Industrial';
    else if (o.value === 'Administrative') o.textContent = 'Administrativo';
    else if (o.value === 'Skilled Trade') o.textContent = 'Oficio Calificado';
  }); }
  // Translate empty state
  var emptyH2 = document.querySelector('.empty h2');
  if (emptyH2) emptyH2.textContent = 'No hay posiciones abiertas en este momento';
  var emptyP = document.querySelector('.empty p');
  if (emptyP) emptyP.textContent = 'Vuelve pronto \u2014 se publican nuevos trabajos todo el tiempo.';
  // Translate job cards
  document.querySelectorAll('.card:not(.empty)').forEach(function(card) {
    if (!card.id) return;
    var titleEs = card.getAttribute('data-title-es');
    var descEs = card.getAttribute('data-desc-es');
    var reqEs = card.getAttribute('data-req-es');
    var hasTranslation = titleEs && titleEs.length > 0;
    var h2 = card.querySelector('h2');
    if (h2) {
      if (hasTranslation) { h2.textContent = titleEs; }
      else { h2.textContent = (_orig[card.id] ? _orig[card.id].title : '') + ' (traducci\u00f3n no disponible)'; }
    }
    var badges = card.querySelectorAll('.badge');
    badges.forEach(function(b) {
      if (b.textContent === 'Administrative') b.textContent = 'Administrativo';
      else if (b.textContent === 'Skilled Trade') b.textContent = 'Oficio Calificado';
    });
    var reqs = card.querySelectorAll('.req');
    if (hasTranslation) {
      reqs.forEach(function(el) {
        var strong = el.querySelector('strong');
        if (strong && strong.textContent.includes('Description')) {
          el.innerHTML = '<strong>Descripci\u00f3n:</strong> ' + descEs.split('\\n').join('<br>');
        } else if (strong && strong.textContent.includes('Requirements')) {
          el.innerHTML = '<strong>Requisitos:</strong> ' + reqEs.split('\\n').join('<br>');
        }
      });
    }
    var btn = card.querySelector('.interest');
    if (btn && !btn.classList.contains('done')) btn.textContent = 'Me Interesa \u270B';
    if (btn && btn.classList.contains('done')) btn.textContent = '\u2713 Inter\u00e9s Enviado';
  });
}


function _restoreEN() {
  var hh = document.querySelector('header h1'); if (hh && _orig._headerH1) hh.textContent = _orig._headerH1;
  var hp = document.querySelector('header p'); if (hp) hp.textContent = _orig._headerP;
  var filterLabel = document.querySelector('label[for="categoryFilter"]');
  if (filterLabel) filterLabel.textContent = 'View as:';
  var catSelect = document.getElementById('categoryFilter');
  if (catSelect) { Array.from(catSelect.options).forEach(function(o) {
    if (o.value === '') o.textContent = 'All Categories';
    else if (o.value === 'Industrial') o.textContent = 'Industrial';
    else if (o.value === 'Administrative') o.textContent = 'Administrative';
    else if (o.value === 'Skilled Trade') o.textContent = 'Skilled Trade';
  }); }
  var emptyH2 = document.querySelector('.empty h2');
  if (emptyH2) emptyH2.textContent = 'No open positions right now';
  var emptyP = document.querySelector('.empty p');
  if (emptyP) emptyP.textContent = 'Check back soon \u2014 new jobs are posted all the time.';
  Object.keys(_orig).forEach(function(id) {
    if (id.startsWith('_')) return;
    var card = document.getElementById(id); if (!card) return;
    var o = _orig[id];
    var h2 = card.querySelector('h2'); if (h2) h2.textContent = o.title;
    var badges = card.querySelectorAll('.badge');
    if (o.badges) o.badges.forEach(function(txt, i) { if (badges[i]) badges[i].textContent = txt; });
    var reqs = card.querySelectorAll('.req');
    o.reqs.forEach(function(html, i) { if (reqs[i]) reqs[i].innerHTML = html; });
    var btn = card.querySelector('.interest'); if (btn && !btn.classList.contains('done')) btn.textContent = o.btn || "I'm Interested \u270b";
  });
}
_captureOrig();
document.querySelectorAll('.interest').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var isDone = btn.classList.contains('done');
    fetch(location.pathname + '/interest', {
      method: isDone ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_order_id: Number(btn.dataset.id) })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res.ok) {
        if (isDone) { btn.textContent = "I'm Interested ✋"; btn.classList.remove('done'); }
        else { btn.textContent = "✓ Interest Submitted"; btn.classList.add('done'); }
      } else { alert('Something went wrong — try again?'); }
    }).catch(function () { alert('Something went wrong — try again?'); });
  });
});

  // Auto-restore language preference
  try { var saved = localStorage.getItem('joblink_lang'); if (saved === 'es') setLang('es'); } catch(e) {}
</script>
</body></html>`;
}

function renderPreviewPage(db, preSelectedCategory) {
  const cats = ['Industrial', 'Administrative', 'Skilled Trade'];
  const validCat = cats.includes(preSelectedCategory) ? preSelectedCategory : '';
  const jobs = db.prepare("SELECT * FROM job_orders WHERE status = 'Published' ORDER BY category, id").all();

  const jobCards = jobs.map((jo) => `
    <div class="card job-card" data-category="${esc(jo.category || '')}" id="job-${jo.id}" data-title-es="${esc(jo.title_es || '')}" data-desc-es="${esc(jo.description_es || '')}" data-req-es="${esc(jo.requirements_es || '')}">
      <h2>${esc(jo.title)}</h2>
      <div class="meta">
        ${jo.category ? '<span class="chip cat-chip">' + esc(jo.category) + '</span>' : ''}
        ${jo.pay ? '<span class="chip pay">\u{1F4B5} ' + esc(jo.pay) + '</span>' : ''}
        ${jo.shift_hours ? '<span class="chip">\u{1F550} ' + esc(jo.shift_hours) + '</span>' : ''}
        ${jo.city_state ? '<span class="chip">\u{1F4CD} ' + esc(jo.city_state) + '</span>' : ''}
      </div>
      ${jo.description ? '<p class="req"><strong>Description:</strong> ' + escNl(jo.description) + '</p>' : ''}
      ${jo.requirements ? '<p class="req"><strong>Requirements:</strong> ' + esc(jo.requirements) + '</p>' : ''}
      <button class="interest preview-toggle">I'm Interested ✋</button>
    </div>`).join('\n');

  const empty = '<div class="card empty" id="emptyMsg"><h2>No published positions right now</h2>' +
    '<p>Publish a job order from the Dashboard to see it here.</p></div>';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<title>Candidate Preview \u2014 JobLink</title>
<style>
  :root { --brand:#3d4ee6; --blue:#2563eb; --green:#10863f; --amber:#b26a06; --surface:#ffffff; --surface-2:#f6f8fc; --border:#e5e9f2; --text:#0f1728; --text-muted:#59617a; --radius:14px; --radius-sm:10px; --shadow-sm:0 1px 2px rgba(16,24,40,.05); }
  * { box-sizing:border-box; margin:0; }
  body { font-family:"Plus Jakarta Sans",system-ui,-apple-system,sans-serif; background:#eef1f8; color:var(--text); padding-bottom:40px; }
  header { background:var(--brand); color:#fff; padding:20px 16px; text-align:center; position:relative; }
  header h1 { font-size:1.25rem; }
  header p { opacity:.9; font-size:.9rem; margin-top:4px; }
  .preview-bar { background:#ffb500; color:var(--text); text-align:center; padding:8px; font-weight:700; font-size:.88rem; }
  main { max-width:560px; margin:0 auto; padding:16px; }
  .filter-bar { background:var(--surface); border-radius:10px; padding:10px 14px; margin-bottom:14px; box-shadow:var(--shadow-sm); display:flex; align-items:center; gap:10px; }
  .filter-bar label { font-size:.85rem; font-weight:600; color:var(--text-muted); white-space:nowrap; }
  .filter-bar select { flex:1; padding:7px 10px; border:1px solid var(--border); border-radius:8px; font-size:.9rem; background:var(--surface); color:var(--text); }
  .card { background:var(--surface); border-radius:var(--radius); padding:18px; margin-bottom:14px; box-shadow:var(--shadow-sm); }
  .card h2 { font-size:1.1rem; color:var(--brand); margin-bottom:8px; }
  .meta { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
  .chip { background:var(--surface-2); border-radius:99px; padding:4px 10px; font-size:.82rem; }
  .chip.pay { background:#dcf3e5; font-weight:600; }
  .req { font-size:.9rem; margin-bottom:8px; }
  p { font-size:.92rem; line-height:1.45; }
  .interest { width:100%; margin-top:12px; padding:13px; border:0; border-radius:var(--radius-sm); background:var(--brand);
    color:#fff; font-size:1rem; font-weight:700; cursor:pointer; transition:background .15s,transform .1s; }
  .interest:active { transform:scale(0.98); }
  .interest.done { background:var(--green); }
  .empty { text-align:center; padding:40px 18px; }
  .count-badge { font-size:.82rem; color:var(--text-muted); text-align:center; margin-bottom:10px; }
  header { position:relative; }
  .lang-row { text-align:center; padding:10px 0 2px; }
  .lang-pill { display:inline-flex; border-radius:99px; overflow:hidden; border:2px solid rgba(255,255,255,0.7); background:rgba(0,0,0,0.2); backdrop-filter:blur(8px); }
  .lang-pill button { padding:8px 16px; border:none; font-size:14px; font-weight:700; cursor:pointer; background:transparent; color:rgba(255,255,255,0.8); transition:background .15s; }
  .lang-pill button.active { background:rgba(255,255,255,0.35); color:#fff; }
  .translating { opacity:0.5; pointer-events:none; transition:opacity .2s; }
</style></head>
<body>
<div class="preview-bar">PREVIEW MODE \u2014 This is what candidates see</div>
<header>
  <h1>Hi there! \u{1F44B}</h1>
  <p>These jobs are open right now \u2014 tap any you'd like to be considered for.</p>
  <div class="lang-row"><div class="lang-pill"><button id="langEN" class="active" onclick="setLang('en')">EN</button><button id="langES" onclick="setLang('es')">ES</button></div></div>
</header>
<main>
  <div class="filter-bar">
    <label for="categoryFilter">View as:</label>
    <select id="categoryFilter" onchange="filterCards()">
      <option value=""${!validCat ? ' selected' : ''}>All Categories</option>
      ${cats.map(c => '<option value="' + c + '"' + (validCat === c ? ' selected' : '') + '>' + c + '</option>').join('\n      ')}
    </select>
  </div>
  <div class="count-badge" id="countBadge"></div>
  ${jobs.length ? jobCards : empty}
</main>
<script>
var _cache = {};
var _orig = {};
var _lang = 'en';

function _hashJobs() {
  var ids = [];
  document.querySelectorAll('.card:not(.empty)').forEach(function(c) { if (c.id) ids.push(c.id); });
  return ids.join(',');
}

function _captureOrig() {
  if (Object.keys(_orig).length) return;
  _orig._headerH1 = document.querySelector('header h1') ? document.querySelector('header h1').textContent : '';
  _orig._headerP = document.querySelector('header p') ? document.querySelector('header p').textContent : '';
  document.querySelectorAll('.card:not(.empty)').forEach(function(card) {
    if (!card.id) return;
    var o = { title: '', reqs: [], btn: '', badges: [] };
    var h2 = card.querySelector('h2'); if (h2) o.title = h2.textContent;
    card.querySelectorAll('.badge').forEach(function(b) { o.badges.push(b.textContent); });
    card.querySelectorAll('.req').forEach(function(el) { o.reqs.push(el.innerHTML); });
    var btn = card.querySelector('.interest'); if (btn) o.btn = btn.textContent.trim();
    _orig[card.id] = o;
  });
}

function setLang(lang) {
  try { localStorage.setItem('joblink_lang', lang); } catch(e) {}
  _lang = lang;
  document.getElementById('langEN').classList.toggle('active', lang === 'en');
  document.getElementById('langES').classList.toggle('active', lang === 'es');
  _captureOrig();
  if (lang === 'en') { _restoreEN(); return; }
  // Translate header
  var hh = document.querySelector('header h1');
  if (hh) { var n = hh.textContent.match(/Hi (.+)!/); hh.textContent = (n && n[1] !== 'there') ? '\u00a1Hola ' + n[1] + '! \u{1F44B}' : '\u00a1Hola! \u{1F44B}'; }
  var hp = document.querySelector('header p');
  if (hp) hp.textContent = 'Estos trabajos est\u00e1n disponibles ahora \u2014 toca cualquiera que te interese.';
  // Translate filter
  var filterLabel = document.querySelector('label[for="categoryFilter"]');
  if (filterLabel) filterLabel.textContent = 'Ver como:';
  var catSelect = document.getElementById('categoryFilter');
  if (catSelect) { Array.from(catSelect.options).forEach(function(o) {
    if (o.value === '') o.textContent = 'Todas las Categor\u00edas';
    else if (o.value === 'Industrial') o.textContent = 'Industrial';
    else if (o.value === 'Administrative') o.textContent = 'Administrativo';
    else if (o.value === 'Skilled Trade') o.textContent = 'Oficio Calificado';
  }); }
  // Translate empty state
  var emptyH2 = document.querySelector('.empty h2');
  if (emptyH2) emptyH2.textContent = 'No hay posiciones abiertas en este momento';
  var emptyP = document.querySelector('.empty p');
  if (emptyP) emptyP.textContent = 'Vuelve pronto \u2014 se publican nuevos trabajos todo el tiempo.';
  // Translate job cards
  document.querySelectorAll('.card:not(.empty)').forEach(function(card) {
    if (!card.id) return;
    var titleEs = card.getAttribute('data-title-es');
    var descEs = card.getAttribute('data-desc-es');
    var reqEs = card.getAttribute('data-req-es');
    var hasTranslation = titleEs && titleEs.length > 0;
    var h2 = card.querySelector('h2');
    if (h2) {
      if (hasTranslation) { h2.textContent = titleEs; }
      else { h2.textContent = (_orig[card.id] ? _orig[card.id].title : '') + ' (traducci\u00f3n no disponible)'; }
    }
    var badges = card.querySelectorAll('.badge');
    badges.forEach(function(b) {
      if (b.textContent === 'Administrative') b.textContent = 'Administrativo';
      else if (b.textContent === 'Skilled Trade') b.textContent = 'Oficio Calificado';
    });
    var reqs = card.querySelectorAll('.req');
    if (hasTranslation) {
      reqs.forEach(function(el) {
        var strong = el.querySelector('strong');
        if (strong && strong.textContent.includes('Description')) {
          el.innerHTML = '<strong>Descripci\u00f3n:</strong> ' + descEs.split('\\n').join('<br>');
        } else if (strong && strong.textContent.includes('Requirements')) {
          el.innerHTML = '<strong>Requisitos:</strong> ' + reqEs.split('\\n').join('<br>');
        }
      });
    }
    var btn = card.querySelector('.interest');
    if (btn && !btn.classList.contains('done')) btn.textContent = 'Me Interesa \u270B';
    if (btn && btn.classList.contains('done')) btn.textContent = '\u2713 Inter\u00e9s Enviado';
  });
}


function _restoreEN() {
  var hh = document.querySelector('header h1'); if (hh && _orig._headerH1) hh.textContent = _orig._headerH1;
  var hp = document.querySelector('header p'); if (hp) hp.textContent = _orig._headerP;
  var filterLabel = document.querySelector('label[for="categoryFilter"]');
  if (filterLabel) filterLabel.textContent = 'View as:';
  var catSelect = document.getElementById('categoryFilter');
  if (catSelect) { Array.from(catSelect.options).forEach(function(o) {
    if (o.value === '') o.textContent = 'All Categories';
    else if (o.value === 'Industrial') o.textContent = 'Industrial';
    else if (o.value === 'Administrative') o.textContent = 'Administrative';
    else if (o.value === 'Skilled Trade') o.textContent = 'Skilled Trade';
  }); }
  var emptyH2 = document.querySelector('.empty h2');
  if (emptyH2) emptyH2.textContent = 'No open positions right now';
  var emptyP = document.querySelector('.empty p');
  if (emptyP) emptyP.textContent = 'Check back soon \u2014 new jobs are posted all the time.';
  Object.keys(_orig).forEach(function(id) {
    if (id.startsWith('_')) return;
    var card = document.getElementById(id); if (!card) return;
    var o = _orig[id];
    var h2 = card.querySelector('h2'); if (h2) h2.textContent = o.title;
    var badges = card.querySelectorAll('.badge');
    if (o.badges) o.badges.forEach(function(txt, i) { if (badges[i]) badges[i].textContent = txt; });
    var reqs = card.querySelectorAll('.req');
    o.reqs.forEach(function(html, i) { if (reqs[i]) reqs[i].innerHTML = html; });
    var btn = card.querySelector('.interest'); if (btn && !btn.classList.contains('done')) btn.textContent = o.btn || "I'm Interested \u270b";
  });
}
_captureOrig();
function filterCards() {
  var sel = document.getElementById("categoryFilter").value;
  var cards = document.querySelectorAll(".job-card");
  var shown = 0;
  cards.forEach(function(c) {
    var match = !sel || c.dataset.category === sel;
    c.style.display = match ? "" : "none";
    if (match) shown++;
  });
  var empty = document.getElementById("emptyMsg");
  if (empty) empty.style.display = (cards.length === 0) ? "" : "none";
  var noMatch = document.getElementById("noMatchMsg");
  if (shown === 0 && cards.length > 0) {
    if (!noMatch) {
      noMatch = document.createElement("div");
      noMatch.id = "noMatchMsg";
      noMatch.className = "card empty";
      noMatch.innerHTML = "<h2>No positions in this category</h2><p>Try a different category or select All.</p>";
      document.querySelector("main").appendChild(noMatch);
    }
    noMatch.style.display = "";
  } else if (noMatch) {
    noMatch.style.display = "none";
  }
  document.getElementById("countBadge").textContent = sel ? (shown + " " + sel + " position" + (shown !== 1 ? "s" : "")) : "";
}
filterCards();
document.querySelectorAll('.preview-toggle').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var isDone = btn.classList.contains('done');
    if (isDone) {
      btn.classList.remove('done');
      btn.textContent = "I'm Interested \u270b";
    } else {
      btn.classList.add('done');
      btn.textContent = "\u2713 Interest Submitted";
    }
  });
});

  // Auto-restore language preference
  try { var saved = localStorage.getItem('joblink_lang'); if (saved === 'es') setLang('es'); } catch(e) {}
</script>
</body></html>`;
}

module.exports = { renderCandidatePage, markInterest, renderPreviewPage };
