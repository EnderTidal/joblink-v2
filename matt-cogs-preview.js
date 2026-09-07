#!/usr/bin/env node
/**
 * matt-cogs-preview.js
 *
 * Runs on the 28th of every month. Sends Josh an email with the estimated
 * COGS invoice amount for Matt's Waxahachie org for the current month
 * (which will be invoiced on the 1st of next month).
 *
 * Cron: 0 9 28 * * (28th of every month at 9 AM)
 */

const { Client } = require("pg");

const RESUMELINE_DB = {
  host: "localhost",
  port: 5432,
  database: "resumeline_prod",
  user: "billyfit_admin",
  password: "REDACTED_PG_PASSWORD",
};

const MATT_ORG_ID = 1;
const RESEND_KEY = process.env.RESEND_KEY || "REDACTED";
const TELEGRAM_BOT_TOKEN = "REDACTED_TELEGRAM_TOKEN";
const ASTRID_CHAT_ID = "-1003928477373";

function getCurrentMonth() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  return { year, monthName: monthNames[month - 1], startDate };
}

async function sendTelegram(message) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: ASTRID_CHAT_ID, text: message }),
  });
  if (!res.ok) console.error("[preview] Telegram failed:", res.status);
}

async function main() {
  const { year, monthName, startDate } = getCurrentMonth();
  const label = `${monthName} ${year}`;

  const pg = new Client(RESUMELINE_DB);
  await pg.connect();

  const result = await pg.query(
    `SELECT
       COUNT(*) AS resume_count,
       COALESCE(SUM(retell_cost), 0) AS total_cost,
       COALESCE(SUM(recording_duration_seconds), 0) AS total_seconds
     FROM resumeline_resumes
     WHERE org_id = $1
       AND created_at >= $2::timestamptz
       AND created_at < (date_trunc('month', $2::date) + interval '1 month')::timestamptz`,
    [MATT_ORG_ID, startDate]
  );
  await pg.end();

  const count = parseInt(result.rows[0].resume_count, 10);
  const cost = parseFloat(result.rows[0].total_cost);
  const minutes = Math.round(parseInt(result.rows[0].total_seconds, 10) / 60);

  // Estimate remaining days
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const daysElapsed = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dailyRate = daysElapsed > 0 ? cost / daysElapsed : 0;
  const projected = dailyRate * daysInMonth;

  const html = `
<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto">
  <div style="background:#1a1a2e;color:white;padding:24px;border-radius:8px 8px 0 0">
    <h2 style="margin:0">COGS Invoice Preview — ${label}</h2>
    <p style="margin:4px 0 0;opacity:0.7;font-size:13px">Matt Tibbetts / Express Waxahachie</p>
  </div>
  <div style="padding:20px;background:#f8f9fa">
    <div style="background:white;padding:16px;border-radius:8px;margin-bottom:12px">
      <h3 style="margin:0 0 12px;color:#1a1a2e">Month-to-Date (Day ${daysElapsed}/${daysInMonth})</h3>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:6px;color:#555">Resumes</td><td style="padding:6px;text-align:right;font-weight:600">${count}</td></tr>
        <tr><td style="padding:6px;color:#555">Retell Cost</td><td style="padding:6px;text-align:right;font-weight:600">$${cost.toFixed(2)}</td></tr>
        <tr><td style="padding:6px;color:#555">Minutes</td><td style="padding:6px;text-align:right">${minutes}</td></tr>
        <tr style="border-top:2px solid #1a1a2e"><td style="padding:6px;font-weight:700">Projected EOM</td><td style="padding:6px;text-align:right;font-weight:700;color:#e67e22">~$${projected.toFixed(2)}</td></tr>
      </table>
    </div>
    <p style="font-size:12px;color:#888">Invoice will be created and sent to Matt on the 1st. This is a preview only.</p>
  </div>
  <div style="padding:12px;background:#1a1a2e;color:white;border-radius:0 0 8px 8px;text-align:center;font-size:11px;opacity:0.8">
    Kingdom Workforce LLC — Automated COGS Preview
  </div>
</div>`;

  // Send preview email to Josh
  const emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + RESEND_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "KWF Reports <josh@joblinkplatform.com>",
      to: ["joshuafriends@gmail.com"],
      subject: `COGS Preview: Matt's ${label} invoice — $${cost.toFixed(2)} (est ~$${projected.toFixed(2)})`,
      html: html,
    }),
  });
  const emailData = await emailRes.json();
  console.log("[preview] Email sent:", JSON.stringify(emailData));

  // Also notify on Telegram
  await sendTelegram(`COGS Preview: Matt's ${label} estimated invoice — $${cost.toFixed(2)} MTD, ~$${projected.toFixed(2)} projected. Invoice sends in 3 days.`);
}

main().catch((err) => {
  console.error("[preview] FATAL:", err.message);
  sendTelegram(`⚠️ COGS preview script failed: ${err.message}`).catch(() => {});
  process.exit(1);
});
