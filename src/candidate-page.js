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
        ${jo.pay ? `<span class="chip pay">💵 ${esc(jo.pay)}</span>` : ''}
        ${jo.shift_hours ? `<span class="chip">🕐 ${esc(jo.shift_hours)}</span>` : ''}
        ${jo.location ? `<span class="chip">📍 ${esc(jo.location)}</span>` : ''}
      </div>
      ${jo.requirements ? `<p class="req"><strong>Requirements:</strong> ${esc(jo.requirements)}</p>` : ''}
      ${jo.description ? `<p>${esc(jo.description)}</p>` : ''}
      <button class="interest ${done ? 'done' : ''}" data-id="${jo.id}" ${done ? 'disabled' : ''}>
        ${done ? "✓ You're on the list!" : "I'm Interested"}
      </button>
    </div>`;
  }).join('\n');

  const empty = `<div class="card empty"><h2>No open positions right now</h2>
    <p>Check back soon — new jobs are posted all the time.</p></div>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jobs for you — Express Employment</title>
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
  <h1>Hi ${esc(candidate.first_name || 'there')}! 👋</h1>
  <p>These jobs are open right now — tap any you'd like to be considered for.</p>
</header>
<main>
  ${category ? `<div class="cat">${esc(category)} positions</div>` : ''}
  ${jobs.length ? jobCards : empty}
</main>
<script>
document.querySelectorAll('.interest:not(.done)').forEach(function (btn) {
  btn.addEventListener('click', function () {
    btn.disabled = true;
    fetch(location.pathname + '/interest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_order_id: Number(btn.dataset.id) })
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (res.ok) { btn.textContent = "✓ You're on the list!"; btn.classList.add('done'); }
      else { btn.disabled = false; alert('Something went wrong — try again?'); }
    }).catch(function () { btn.disabled = false; });
  });
});
</script>
</body></html>`;
}

module.exports = { renderCandidatePage, markInterest };
