// joblink-schedule-preview.cjs
// Fix: Preview screen shows scheduled time, button label reflects schedule vs send-now
// Patches: src/tom.js + public/thewizard.html (STAGING ONLY)

const fs = require('fs');
const path = require('path');

const TOM = path.join(__dirname, 'src', 'tom.js');
const WIZ = path.join(__dirname, 'public', 'thewizard.html');

function insertAfter(filePath, needle, newLines, label) {
  let lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let idx = lines.findIndex(l => l.includes(needle));
  if (idx === -1) { console.error(`FAIL [${label}]: "${needle}" not found`); process.exit(1); }
  lines.splice(idx + 1, 0, ...newLines);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  console.log(`OK [${label}]`);
}

function replaceBlock(filePath, startNeedle, endNeedle, newLines, label) {
  let lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let s = lines.findIndex(l => l.includes(startNeedle));
  if (s === -1) { console.error(`FAIL [${label}]: start "${startNeedle}" not found`); process.exit(1); }
  let e = -1;
  for (let i = s; i < lines.length; i++) {
    if (lines[i].includes(endNeedle)) { e = i; break; }
  }
  if (e === -1) { console.error(`FAIL [${label}]: end "${endNeedle}" not found`); process.exit(1); }
  lines.splice(s, e - s + 1, ...newLines);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  console.log(`OK [${label}]: lines ${s+1}-${e+1}`);
}

function replaceLine(filePath, needle, newContent, label) {
  let lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let idx = lines.findIndex(l => l.includes(needle));
  if (idx === -1) { console.error(`FAIL [${label}]: "${needle}" not found`); process.exit(1); }
  lines[idx] = newContent;
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  console.log(`OK [${label}]`);
}

// ====== tom.js ======

// 1. Read send_at from payload
insertAfter(TOM,
  'const skipBlastGuard = payload?.skipBlastGuard === true;',
  ['        const sendAtRaw = payload?.send_at || null;'],
  'tom: read send_at'
);

// 2. Store sendAt on session
insertAfter(TOM,
  's.data.selectedFromNumber = selectedFromNumber;',
  ['        s.data.sendAt = sendAtRaw;'],
  'tom: store sendAt'
);

// 3. Replace preview reply block
replaceBlock(TOM,
  "s.state = 'preview';",
  "confirmButton: { action: 'confirm_send', label: `Send to ${plan.sendable.length} people` },",
  [
    "        // Build schedule-aware preview",
    "        const _schedTz = (db.prepare(\"SELECT value FROM settings WHERE key = 'timezone'\").get() || {}).value || 'America/Chicago';",
    "        let _schedLine = '';",
    "        let _confirmBtn;",
    "        if (sendAtRaw) {",
    "          const _sTime = new Date(sendAtRaw).toLocaleString('en-US', { timeZone: _schedTz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });",
    "          const _sTzA = new Date(sendAtRaw).toLocaleString('en-US', { timeZone: _schedTz, timeZoneName: 'short' }).split(' ').pop();",
    "          _schedLine = `\\u23F0 Scheduled for: ${_sTime} ${_sTzA}\\n`;",
    "          _confirmBtn = { action: 'schedule_send', label: `Schedule blast for ${_sTime} ${_sTzA}`, send_at: sendAtRaw };",
    "        } else {",
    "          _confirmBtn = { action: 'confirm_send', label: `Send to ${plan.sendable.length} people` };",
    "        }",
    "",
    "        s.state = 'preview';",
    "        persistSession(s); return reply(s,",
    "          `Blast preview \\u2014 ${category}\\n` +",
    "          `Template: ${s.data.template.name}\\n` +",
    "          `Sample message: \"${sample}\"\\n\\n` +",
    "          `${plan.sendable.length} will be sent${skippedBits.length ? ', ' + skippedBits.join(', ') : ''}.\\n` +",
    "          (recruiterUsername ? `Recruiter: ${recruiterUsername}\\n` : '') +",
    "          _schedLine +",
    "          (skipBlastGuard ? `\\u26A0\\uFE0F BLAST GUARD OVERRIDDEN \\u2014 cooldown skipped\\n` : '') +",
    "          (sendAtRaw ? '\\nPress the Schedule button to confirm. You can safely close this tab after \\u2014 your blast will be sent at the scheduled time.' : '\\nPress the Send button to send. You can safely close this tab after \\u2014 your blast will continue in the background.'),",
    "          {",
    "            confirmButton: _confirmBtn,",
  ],
  'tom: schedule-aware preview'
);

console.log('tom.js done.\n');

// ====== thewizard.html ======

// 1. submitBlastForm accepts opts
replaceLine(WIZ,
  'async function submitBlastForm() {',
  'async function submitBlastForm(schedOpts) {',
  'wiz: submitBlastForm sig'
);
insertAfter(WIZ,
  'var vals = getBlastFormValues();',
  ['  if (schedOpts && schedOpts.send_at) { vals.send_at = schedOpts.send_at; }'],
  'wiz: pass send_at to vals'
);

// 2. Confirm button block — replace from textContent line through sendAction line
replaceBlock(WIZ,
  "extra.confirmButton.label;",
  "sendAction(extra.confirmButton.action, {});",
  [
    "      b.textContent = (extra.confirmButton.action === 'schedule_send' ? '\\u23F0 ' : '\\uD83D\\uDE80 ') + extra.confirmButton.label;",
    "      b.onclick = function() {",
    "        // Disable ALL buttons in this choices area to prevent double-send",
    "        b.parentElement.querySelectorAll('button').forEach(function(btn) { btn.disabled = true; });",
    "        b.textContent = extra.confirmButton.action === 'schedule_send' ? 'Scheduling...' : 'Sending...';",
    "        if (extra.confirmButton.action === 'confirm_send') blastProgressMode = true;",
    "        var actionPayload = {};",
    "        if (extra.confirmButton.send_at) actionPayload.send_at = extra.confirmButton.send_at;",
    "        sendAction(extra.confirmButton.action, actionPayload);",
  ],
  'wiz: confirm button schedule-aware'
);

// 3. Safe note text — replace the line containing safeNote.textContent
replaceBlock(WIZ,
  "safeNote.textContent = 'You can safely close this tab",
  "in the background.';",
  [
    "        safeNote.textContent = extra.confirmButton.action === 'schedule_send'",
    "          ? 'You can safely close this tab after clicking Schedule \\u2014 your blast will be sent at the scheduled time.'",
    "          : 'You can safely close this tab after clicking Send \\u2014 your blast will continue sending in the background.';",
  ],
  'wiz: safe note schedule-aware'
);

console.log('thewizard.html done.');
console.log('\nAll patches applied successfully.');
