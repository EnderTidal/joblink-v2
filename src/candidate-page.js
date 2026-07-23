// The magic link page — what a candidate sees at /m/<token>.
// Server-rendered, phone-first, zero build step. Shows every PUBLISHED job
// order in the candidate's current category (most recent blast wins), with
// an "I'm Interested" button per job. No PII in the URL — just the token.

const { publishedInCategory } = require('./job-orders');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function markInterest(db, candidate, jobOrderId) {
  const jo = db.prepare(`SELECT * FROM job_orders WHERE id = ? AND status = 'Published'`).get(jobOrderId);
  if (!jo) return { ok: false, error: 'job_not_available' };
  // Attribute the interest to the blast that brought them in: their latest blast
  const blast = db.prepare(
    `SELECT b.id FROM blasts b JOIN blast_recipients br ON br.blast_id = b.id
     WHERE br.phone = ? AND br.status = 'sent' ORDER BY b.id DESC LIMIT 1`,
  ).get(candidate.phone);
  db.prepare(
    'INSERT OR IGNORE INTO interests (phone, job_order_id, blast_id) VALUES (?, ?, ?)',
  ).run(candidate.phone, jobOrderId, blast ? blast.id : null);
  return { ok: true };
}

function renderCandidatePage(db, candidate) {
  const category = candidate.current_category;
  const jobs = category ? publishedInCategory(db, category) : [];
  const interested = new Set(
    db.prepare('SELECT job_order_id FROM interests WHERE phone = ?').all(candidate.phone).map((r) => r.job_order_id),
  );

  const jobCards = jobs.map((jo) => {
    const done = interested.has(jo.id);
    return `
    <div class="card" id="job-${jo.id}">
      <h2>${esc(jo.title)}</h2>
      <div class="meta">
        ${jo.pay ? `<span class="chip pay">\u{1F4B5} ${esc(jo.pay)}</span>` : ''}
        ${jo.shift_hours ? `<span class="chip">\u{1F550} ${esc(jo.shift_hours)}</span>` : ''}
        ${jo.city_state ? `<span class="chip">\u{1F4CD} ${esc(jo.city_state)}</span>` : ''}
      </div>
      ${jo.description ? `<p class="req"><strong>Description:</strong> ${esc(jo.description)}</p>` : ''}
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
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jobs for you \u2014 Express Employment</title>
<style>
  :root { --blue:#00529b; --gold:#ffb500; }
  * { box-sizing:border-box; margin:0; }
  body { font-family:-apple-system,'Segoe UI',Roboto,sans-serif; background:#f2f5f9; color:#1a2733; padding-bottom:40px; }
  header { background:var(--blue); color:#fff; padding:20px 16px; text-align:center; }
  header h1 { font-size:1.25rem; }
  header p { opacity:.9; font-size:.9rem; margin-top:4px; }
  main { max-width:560px; margin:0 auto; padding:16px; }
  .card { background:#fff; border-radius:12px; padding:18px; margin-bottom:14px; box-shadow:0 1px 4px rgba(10,40,80,.08); }
  .card h2 { font-size:1.1rem; color:var(--blue); margin-bottom:8px; }
  .meta { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
  .chip { background:#eef3f9; border-radius:999px; padding:4px 10px; font-size:.82rem; }
  .chip.pay { background:#e7f6e9; font-weight:600; }
  .req { font-size:.9rem; margin-bottom:8px; }
  p { font-size:.92rem; line-height:1.45; }
  .interest { width:100%; margin-top:12px; padding:13px; border:0; border-radius:9px; background:var(--gold);
    color:#1a2733; font-size:1rem; font-weight:700; cursor:pointer; }
  .interest.done { background:#2e8540; color:#fff; }
  .empty { text-align:center; padding:40px 18px; }
  .cat { text-align:center; font-size:.85rem; color:#5a6b7c; margin:4px 0 12px; }
</style></head>
<body>
<header>
  <h1>Hi ${esc(candidate.first_name || 'there')}! \u{1F44B}</h1>
  <p>These jobs are open right now \u2014 tap any you'd like to be considered for.</p>
</header>
<main>
  ${category ? `<div class="cat">${esc(category)} positions</div>` : ''}
  ${jobs.length ? jobCards : empty}
</main>
<script>
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
</script>
</body></html>`;
}

function renderPreviewPage(db, preSelectedCategory) {
  const cats = ['Industrial', 'Administrative', 'Skilled Trade'];
  const validCat = cats.includes(preSelectedCategory) ? preSelectedCategory : '';
  const jobs = db.prepare("SELECT * FROM job_orders WHERE status = 'Published' ORDER BY category, id").all();

  const jobCards = jobs.map((jo) => `
    <div class="card job-card" data-category="${esc(jo.category || '')}" id="job-${jo.id}">
      <h2>${esc(jo.title)}</h2>
      <div class="meta">
        ${jo.category ? '<span class="chip cat-chip">' + esc(jo.category) + '</span>' : ''}
        ${jo.pay ? '<span class="chip pay">\u{1F4B5} ' + esc(jo.pay) + '</span>' : ''}
        ${jo.shift_hours ? '<span class="chip">\u{1F550} ' + esc(jo.shift_hours) + '</span>' : ''}
        ${jo.city_state ? '<span class="chip">\u{1F4CD} ' + esc(jo.city_state) + '</span>' : ''}
      </div>
      ${jo.description ? '<p class="req"><strong>Description:</strong> ' + esc(jo.description) + '</p>' : ''}
      ${jo.requirements ? '<p class="req"><strong>Requirements:</strong> ' + esc(jo.requirements) + '</p>' : ''}
      <button class="interest" disabled>I'm Interested ✋</button>
    </div>`).join('\n');

  const empty = '<div class="card empty" id="emptyMsg"><h2>No published positions right now</h2>' +
    '<p>Publish a job order from the Dashboard to see it here.</p></div>';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Candidate Preview \u2014 JobLink</title>
<style>
  :root { --blue:#00529b; --gold:#ffb500; }
  * { box-sizing:border-box; margin:0; }
  body { font-family:-apple-system,"Segoe UI",Roboto,sans-serif; background:#f2f5f9; color:#1a2733; padding-bottom:40px; }
  header { background:var(--blue); color:#fff; padding:20px 16px; text-align:center; }
  header h1 { font-size:1.25rem; }
  header p { opacity:.9; font-size:.9rem; margin-top:4px; }
  .preview-bar { background:#ffb500; color:#1a2733; text-align:center; padding:8px; font-weight:700; font-size:.88rem; }
  main { max-width:560px; margin:0 auto; padding:16px; }
  .filter-bar { background:#fff; border-radius:10px; padding:10px 14px; margin-bottom:14px; box-shadow:0 1px 4px rgba(10,40,80,.08); display:flex; align-items:center; gap:10px; }
  .filter-bar label { font-size:.85rem; font-weight:600; color:#5a6b7c; white-space:nowrap; }
  .filter-bar select { flex:1; padding:7px 10px; border:1.5px solid #d0d7de; border-radius:8px; font-size:.9rem; background:#fff; color:#1a2733; }
  .card { background:#fff; border-radius:12px; padding:18px; margin-bottom:14px; box-shadow:0 1px 4px rgba(10,40,80,.08); }
  .card h2 { font-size:1.1rem; color:var(--blue); margin-bottom:8px; }
  .meta { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
  .chip { background:#eef3f9; border-radius:999px; padding:4px 10px; font-size:.82rem; }
  .chip.pay { background:#e7f6e9; font-weight:600; }
  .req { font-size:.9rem; margin-bottom:8px; }
  p { font-size:.92rem; line-height:1.45; }
  .interest { width:100%; margin-top:12px; padding:13px; border:0; border-radius:9px; background:#2e8540;
    color:#fff; font-size:1rem; font-weight:700; cursor:default; }
  .empty { text-align:center; padding:40px 18px; }
  .count-badge { font-size:.82rem; color:#5a6b7c; text-align:center; margin-bottom:10px; }
</style></head>
<body>
<div class="preview-bar">PREVIEW MODE \u2014 This is what candidates see</div>
<header>
  <h1>Hi there! \u{1F44B}</h1>
  <p>These jobs are open right now \u2014 tap any you'd like to be considered for.</p>
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
</script>
</body></html>`;
}

module.exports = { renderCandidatePage, markInterest, renderPreviewPage };
