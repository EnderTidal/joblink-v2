// QuickBooks Online OAuth endpoints — public (no auth), mounted before auth middleware.
// Rate limited: 5 requests per minute per IP on all /api/qbo-* routes.
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const rateLimit = require("express-rate-limit");

const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID || "ABb4cbjzdI4hVwcJI1Fqm61w46s3fcNy4Ze1ZHa2x8H28ifmAw";
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET || "aFCjZChe729kORQamKKZehX3APXwgSodAWTAnoHk";
const QBO_REALM_ID = process.env.QBO_REALM_ID || "9341457804886708";
const QBO_REDIRECT_URI = "https://app.joblinkplatform.com/api/qbo-callback";
const TOKEN_FILE = path.join(__dirname, "..", "data", "qbo-tokens.json");

const TLB_PG = "postgresql://MYETaI717uhIW5BW:6ohQogrLkDupoVCnUR35AcV82z98yJSj@2.25.169.56:32770/iaQwtzM61qL0uqKf";
const VAULT_PASSPHRASE = "1d8cd58d24d542c0ce041266850bcea327f6b12f9aad8bc99d951216502710f5";

// In-memory state for CSRF
let pendingState = null;

// QBO rate limiter — 5 requests per minute per IP
const qboLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited", message: "Too many QBO requests. Please try again in a minute." },
});

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

async function storeTokensInVault(tokens) {
  const c = new Client({ connectionString: TLB_PG });
  try {
    await c.connect();
    const pairs = [
      ["qbo_access_token", tokens.access_token, "QBO OAuth access token"],
      ["qbo_refresh_token", tokens.refresh_token, "QBO OAuth refresh token"],
      ["qbo_token_expiry", String(tokens.expires_at), "QBO token expiry timestamp (ms)"],
      ["qbo_realm_id", tokens.realm_id, "QBO company realm ID"],
    ];
    for (const [name, value, desc] of pairs) {
      await c.query(
        "INSERT INTO secrets (name, service, encrypted_value, description) " +
        "VALUES ($1, 'quickbooks', encrypt_secret($2, $3), $4) " +
        "ON CONFLICT (name) DO UPDATE SET encrypted_value = encrypt_secret($2, $3), description = $4",
        [name, value, VAULT_PASSPHRASE, desc]
      );
    }
    console.log("[qbo] Tokens stored in vault (4 secrets)");
  } catch (err) {
    console.error("[qbo] Vault store failed:", err.message);
  } finally {
    await c.end();
  }
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
  storeTokensInVault(updated).catch(() => {}); // fire-and-forget vault update on refresh
  return updated;
}

function createQboRoutes() {
  const router = express.Router();

  // Apply rate limiter only to QBO-specific paths (not all traffic through the router)
  router.use("/api/qbo-connect", qboLimiter);
  router.use("/api/qbo-callback", qboLimiter);
  router.use("/api/qbo-disconnect", qboLimiter);
  router.use("/api/qbo-test", qboLimiter);

  // 1. Initiate OAuth — redirect to Intuit
  router.get("/api/qbo-connect", (_req, res) => {
    pendingState = crypto.randomBytes(16).toString("hex");
    const url =
      "https://appcenter.intuit.com/connect/oauth2?" +
      new URLSearchParams({
        client_id: QBO_CLIENT_ID,
        redirect_uri: QBO_REDIRECT_URI,
        response_type: "code",
        scope: "com.intuit.quickbooks.accounting",
        state: pendingState,
      }).toString();
    res.redirect(url);
  });

  // 2. OAuth callback — exchange code for tokens
  const usedCodes = new Set();

  router.get("/api/qbo-callback", async (req, res) => {
    try {
      // Block bots/crawlers from replaying the callback
      const ua = (req.headers["user-agent"] || "").toLowerCase();
      if (ua.includes("bot") || ua.includes("crawler") || ua.includes("preview")) {
        return res.status(200).send("<html><body>QuickBooks Connected!</body></html>");
      }

      const { code, state, realmId, error } = req.query;

      // Prevent double-exchange of the same auth code
      if (code && usedCodes.has(code)) {
        return res.status(200).send('<html><body style="text-align:center;padding-top:40vh;font-family:sans-serif"><h2 style="color:green">&#10004; QuickBooks Connected!</h2><p>You can close this tab.</p></body></html>');
      }
      if (code) usedCodes.add(code);
      if (error) return res.status(400).send("Authorization denied: " + error);
      if (!code) return res.status(400).send("Missing authorization code");
      if (pendingState && state !== pendingState) {
        return res.status(400).send("State mismatch — possible CSRF");
      }
      pendingState = null;

      const tokenRes = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
        method: "POST",
        headers: {
          Authorization: basicAuth(),
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: QBO_REDIRECT_URI,
        }),
      });

      if (!tokenRes.ok) {
        const txt = await tokenRes.text();
        console.error("[qbo-callback] Token exchange failed:", tokenRes.status, txt);
        return res.status(500).send("Token exchange failed: " + tokenRes.status);
      }

      const data = await tokenRes.json();
      const tokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        realm_id: realmId || QBO_REALM_ID,
        expires_at: Date.now() + data.expires_in * 1000,
        updated_at: new Date().toISOString(),
      };
      writeTokens(tokens);
      await storeTokensInVault(tokens);
      console.log("[qbo] Connected — realm", tokens.realm_id);

      res.send(
        '<!DOCTYPE html><html><head><title>QuickBooks Connected</title></head>' +
        '<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
        '<div style="text-align:center"><h1 style="color:#2ca01c">&#10003; QuickBooks Connected!</h1>' +
        '<p>Tokens saved to vault. You can close this tab.</p></div></body></html>'
      );
    } catch (err) {
      console.error("[qbo-callback]", err);
      res.status(500).send("OAuth callback error: " + err.message);
    }
  });

  // 3. Disconnect — clear stored tokens
  router.get("/api/qbo-disconnect", (_req, res) => {
    try {
      if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
      res.json({ ok: true, message: "QuickBooks disconnected" });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 4. Smoke test — hit CompanyInfo endpoint
  router.get("/api/qbo-test", async (_req, res) => {
    try {
      let tokens = readTokens();
      if (!tokens) return res.status(400).json({ error: "No QBO tokens stored. Connect first via /api/qbo-connect" });

      // Auto-refresh if expired
      if (Date.now() >= tokens.expires_at) {
        console.log("[qbo-test] Token expired, refreshing...");
        tokens = await refreshAccessToken(tokens);
      }

      const realmId = tokens.realm_id || QBO_REALM_ID;
      const apiRes = await fetch(
        "https://quickbooks.api.intuit.com/v3/company/" + realmId + "/companyinfo/" + realmId + "?minorversion=73",
        {
          headers: {
            Authorization: "Bearer " + tokens.access_token,
            Accept: "application/json",
          },
        }
      );

      if (!apiRes.ok) {
        const txt = await apiRes.text();
        return res.status(apiRes.status).json({ error: "QBO API error", status: apiRes.status, body: txt });
      }

      const info = await apiRes.json();
      const name = info.CompanyInfo ? info.CompanyInfo.CompanyName : "unknown";
      res.json({ ok: true, company: name, realm_id: realmId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createQboRoutes };
