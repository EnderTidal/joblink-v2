// lib/qbo-client.js — QBO API client with token management and auto-refresh
const fs = require("fs");
const path = require("path");

const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID || "ABI1BSXAUJmptnrbxGXZuOS51P1G8kTGdWo6w04qzQWiJddh2N";
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET || "vNCfwfy2VW90ltrfnx4S7mplsFoDUPjXUJxdcXPg";
const QBO_REALM_ID = process.env.QBO_REALM_ID || "9341457804886708";
const TOKEN_FILE = path.join(__dirname, "..", "data", "qbo-tokens.json");
const QBO_BASE = "https://quickbooks.api.intuit.com/v3/company";
const MINOR_VERSION = 73;

function basicAuth() {
  return "Basic " + Buffer.from(QBO_CLIENT_ID + ":" + QBO_CLIENT_SECRET).toString("base64");
}

function readTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeTokens(data) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
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
  return updated;
}

/** Get a valid access token, auto-refreshing if needed. */
async function getValidToken() {
  let tokens = readTokens();
  if (!tokens) throw new Error("No QBO tokens. Connect via /api/qbo-connect first.");
  // Refresh if within 5 min of expiry
  if (Date.now() >= (tokens.expires_at - 300000)) {
    console.log("[qbo-client] Token expiring, refreshing...");
    tokens = await refreshAccessToken(tokens);
  }
  return tokens;
}

/** Make an authenticated QBO API request. */
async function qboRequest(method, endpoint, body = null) {
  const tokens = await getValidToken();
  const realmId = tokens.realm_id || QBO_REALM_ID;
  const url = `${QBO_BASE}/${realmId}/${endpoint}?minorversion=${MINOR_VERSION}`;

  const opts = {
    method,
    headers: {
      Authorization: "Bearer " + tokens.access_token,
      Accept: "application/json",
    },
  };

  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`QBO API ${method} ${endpoint}: ${res.status} ${txt}`);
  }
  return res.json();
}

/** GET convenience. */
async function qboGet(endpoint) {
  return qboRequest("GET", endpoint);
}

/** POST convenience. */
async function qboPost(endpoint, body) {
  return qboRequest("POST", endpoint, body);
}

/** Query using QBO query language. */
async function qboQuery(sql) {
  const tokens = await getValidToken();
  const realmId = tokens.realm_id || QBO_REALM_ID;
  const url = `${QBO_BASE}/${realmId}/query?query=${encodeURIComponent(sql)}&minorversion=${MINOR_VERSION}`;
  const res = await fetch(url, {
    headers: {
      Authorization: "Bearer " + tokens.access_token,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`QBO query failed: ${res.status} ${txt}`);
  }
  return res.json();
}

/** Create an invoice and optionally email it. */
async function createInvoice({ customerId, lineItems, docNumber, dueDate, memo }) {
  const invoice = {
    CustomerRef: { value: String(customerId) },
    DocNumber: docNumber,
    TxnDate: new Date().toISOString().split("T")[0],
    DueDate: dueDate,
    PrivateNote: memo || "",
    Line: lineItems.map((item, i) => ({
      Amount: item.amount,
      DetailType: "SalesItemLineDetail",
      Description: item.description,
      SalesItemLineDetail: {
        ItemRef: item.itemId ? { value: String(item.itemId) } : undefined,
        Qty: 1,
        UnitPrice: item.amount,
      },
    })),
  };

  const result = await qboPost("invoice", invoice);
  return result.Invoice;
}

/** Send an invoice via email. */
async function emailInvoice(invoiceId, email) {
  const tokens = await getValidToken();
  const realmId = tokens.realm_id || QBO_REALM_ID;
  const url = `${QBO_BASE}/${realmId}/invoice/${invoiceId}/send?sendTo=${encodeURIComponent(email)}&minorversion=${MINOR_VERSION}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + tokens.access_token,
      Accept: "application/json",
      "Content-Type": "application/octet-stream",
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Email invoice failed: ${res.status} ${txt}`);
  }
  return res.json();
}

/** Health check — returns company name or throws. */
async function healthCheck() {
  const tokens = await getValidToken();
  const realmId = tokens.realm_id || QBO_REALM_ID;
  const data = await qboGet(`companyinfo/${realmId}`);
  return {
    ok: true,
    company: data.CompanyInfo?.CompanyName || "unknown",
    realm_id: realmId,
    token_expires: new Date(tokens.expires_at).toISOString(),
  };
}

module.exports = {
  getValidToken,
  qboRequest,
  qboGet,
  qboPost,
  qboQuery,
  createInvoice,
  emailInvoice,
  healthCheck,
  readTokens,
  writeTokens,
  refreshAccessToken,
};
