#!/usr/bin/env node
/**
 * matt-cogs-invoice.js
 *
 * Monthly COGS invoice for Matt Tibbetts (Express Waxahachie, org_id=1).
 * Queries ResumeLine usage for the previous calendar month, creates a QBO invoice,
 * emails it to Matt, and notifies Josh on Telegram.
 *
 * Runs from /root/joblink-v2 (for node_modules).
 * Cron: 0 9 1 * * (1st of every month at 9 AM server time)
 *
 * Usage:
 *   node /root/matt-cogs-invoice.js           # live — creates invoice + sends
 *   node /root/matt-cogs-invoice.js --dry-run  # prints what it would do, no side effects
 */

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const https = require("https");

// ─── Config ───────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");

const RESUMELINE_DB = {
  host: "localhost",
  port: 5432,
  database: "resumeline_prod",
  user: "billyfit_admin",
  password: "REDACTED_PG_PASSWORD",
};

const MATT_ORG_ID = 1;
const MATT_QBO_CUSTOMER_ID = "3";
const MATT_EMAIL = "tibbettsmatt@gmail.com";

// QBO — note: the qbo.js route file has these assigned to the "wrong" variable names
// but they work. We match the production code exactly.
const QBO_CLIENT_ID = "aFCjZChe729kORQamKKZehX3APXwgSodAWTAnoHk";
const QBO_CLIENT_SECRET = "ABb4cbjzdI4hVwcJI1Fqm61w46s3fcNy4Ze1ZHa2x8H28ifmAw";
const QBO_REALM_ID = "9341457804886708";
// Script lives at /root/joblink-v2/matt-cogs-invoice.js
const TOKEN_FILE = path.join(__dirname, "data", "qbo-tokens.json");

const TELEGRAM_BOT_TOKEN = "REDACTED_TELEGRAM_TOKEN";
const ASTRID_CHAT_ID = "-1003928477373";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTokenFile() {
  if (fs.existsSync(TOKEN_FILE)) return TOKEN_FILE;
  throw new Error("QBO tokens file not found at " + TOKEN_FILE);
}

function readTokens() {
  return JSON.parse(fs.readFileSync(getTokenFile(), "utf8"));
}

function writeTokens(data) {
  const f = getTokenFile();
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
}

function basicAuth() {
  return "Basic " + Buffer.from(QBO_CLIENT_ID + ":" + QBO_CLIENT_SECRET).toString("base64");
}

async function refreshAccessToken(tokens) {
  const res = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: {
      Authorization: basicAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error("Token refresh failed: " + res.status + " " + txt);
  }
  const data = await res.json();
  const updated = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    realm_id: tokens.realm_id,
    expires_at: Date.now() + data.expires_in * 1000,
    updated_at: new Date().toISOString(),
  };
  writeTokens(updated);
  console.log("[cogs] QBO token refreshed");
  return updated;
}

async function getValidToken() {
  let tokens = readTokens();
  // Refresh if expired or expiring within 5 minutes
  if (!tokens.expires_at || Date.now() > tokens.expires_at - 5 * 60 * 1000) {
    console.log("[cogs] Token expired or expiring soon, refreshing...");
    tokens = await refreshAccessToken(tokens);
  }
  return tokens;
}

async function qboApi(method, endpoint, tokens, body = null) {
  const url = `https://quickbooks.api.intuit.com/v3/company/${QBO_REALM_ID}${endpoint}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`QBO API ${method} ${endpoint} failed: ${res.status} ${text}`);
  }
  return JSON.parse(text);
}

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: ASTRID_CHAT_ID,
      text: message,
      parse_mode: "HTML",
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error("[cogs] Telegram send failed:", res.status, txt);
  } else {
    console.log("[cogs] Telegram notification sent");
  }
}

function getPreviousMonth() {
  // Use Pacific time to determine "now"
  const now = new Date();
  const pacific = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));

  // Previous month
  const year = pacific.getMonth() === 0 ? pacific.getFullYear() - 1 : pacific.getFullYear();
  const month = pacific.getMonth() === 0 ? 12 : pacific.getMonth(); // 1-indexed

  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  // End date = first day of current month
  const endDate = `${pacific.getFullYear()}-${String(pacific.getMonth() + 1).padStart(2, "0")}-01`;

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const monthName = monthNames[month - 1];

  return { year, month, monthName, startDate, endDate };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { year, monthName, startDate, endDate } = getPreviousMonth();
  const label = `${monthName} ${year}`;

  console.log(`[cogs] ${DRY_RUN ? "DRY RUN — " : ""}Processing COGS for ${label}`);
  console.log(`[cogs] Date range: ${startDate} to ${endDate} (exclusive)`);

  // 1. Query ResumeLine usage
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
       AND created_at < $3::timestamptz`,
    [MATT_ORG_ID, startDate, endDate]
  );
  await pg.end();

  const { resume_count, total_cost, total_seconds } = result.rows[0];
  const count = parseInt(resume_count, 10);
  const cost = parseFloat(total_cost);
  const minutes = Math.round(parseInt(total_seconds, 10) / 60);

  console.log(`[cogs] ${label}: ${count} resumes, $${cost.toFixed(2)} Retell cost, ${minutes} min`);

  // 2. If zero usage, notify and exit
  if (cost === 0 || count === 0) {
    const msg = `Matt's Waxahachie had 0 ResumeLine usage for ${label}. No invoice.`;
    console.log(`[cogs] ${msg}`);
    if (!DRY_RUN) {
      await sendTelegram(msg);
    } else {
      console.log(`[cogs] DRY RUN — would send Telegram: "${msg}"`);
    }
    return;
  }

  // 3. Create QBO invoice
  const description = `ResumeLine Retell Usage — ${label} (${count} resumes, ${minutes} minutes)`;
  const invoiceBody = {
    CustomerRef: { value: MATT_QBO_CUSTOMER_ID },
    BillEmail: { Address: MATT_EMAIL },
    Line: [
      {
        DetailType: "SalesItemLineDetail",
        Amount: cost,
        Description: description,
        SalesItemLineDetail: {
          Quantity: 1,
          UnitPrice: cost,
        },
      },
    ],
    DueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
    PrivateNote: `Auto-generated COGS invoice for org_id=${MATT_ORG_ID}, ${label}`,
  };

  if (DRY_RUN) {
    console.log(`[cogs] DRY RUN — would create QBO invoice:`);
    console.log(JSON.stringify(invoiceBody, null, 2));
    console.log(`[cogs] DRY RUN — would email invoice to ${MATT_EMAIL}`);
    console.log(`[cogs] DRY RUN — would send Telegram: "Matt invoiced $${cost.toFixed(2)} for ${label} ResumeLine COGS (${count} resumes)"`);
    return;
  }

  // Live mode
  const tokens = await getValidToken();

  // Create the invoice
  const invoiceResult = await qboApi("POST", "/invoice?minorversion=65", tokens, invoiceBody);
  const invoiceId = invoiceResult.Invoice.Id;
  console.log(`[cogs] Invoice created: #${invoiceId}`);

  // Send the invoice via QBO email
  const sendResult = await qboApi("POST", `/invoice/${invoiceId}/send?sendTo=${encodeURIComponent(MATT_EMAIL)}&minorversion=65`, tokens);
  console.log(`[cogs] Invoice #${invoiceId} emailed to ${MATT_EMAIL}`);

  // 4. Telegram notification
  const tgMsg = `Matt invoiced $${cost.toFixed(2)} for ${label} ResumeLine COGS (${count} resumes)`;
  await sendTelegram(tgMsg);

  console.log(`[cogs] Done — $${cost.toFixed(2)} invoiced for ${label}`);
}

main().catch((err) => {
  console.error("[cogs] FATAL:", err.message);
  // Try to notify on Telegram even on failure
  sendTelegram(`⚠️ COGS invoice script failed: ${err.message}`).catch(() => {});
  process.exit(1);
});
