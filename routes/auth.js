// Auth — email-based login with invitations, magic links, and password reset.
// Backwards-compatible: existing username/password login still works, but the
// primary identifier is now email. First boot seeds admin with joshuafriends@gmail.com.

const express = require('express');
const crypto = require('node:crypto');
const https = require('node:https');
const bcrypt = require('bcryptjs');
const { getSetting } = require('../src/db');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours
const MAGIC_TTL_MS = 15 * 60 * 1000; // 15 minutes
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

const RESEND_KEY = process.env.RESEND_KEY || '';
const FROM_EMAIL = 'JobLink <resume@thetelosway.com>';

/** Send email via Resend API */
function sendEmail(to, subject, html) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html });
    const opts = {
      hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(opts, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(out));
        else reject(new Error(`Resend ${res.statusCode}: ${out}`));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function createAuth(db) {
  const sessions = new Map(); // token -> { username, role, email, expires }

  // Seed a first admin if the users table is empty
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count === 0) {
    db.prepare('INSERT INTO users (username, password_hash, role, email, email_verified) VALUES (?, ?, ?, ?, ?)')
      .run('admin', bcrypt.hashSync('joblink2026', 10), 'admin', 'joshuafriends@gmail.com', 1);
    console.log('[auth] Seeded default admin — email: joshuafriends@gmail.com, password: joblink2026 (CHANGE THIS)');
  }

  function getSession(req) {
    const token = (req.headers.cookie || '').split(';').map((s) => s.trim())
      .find((s) => s.startsWith('jl_session='))?.slice('jl_session='.length);
    if (!token) return null;
    const s = sessions.get(token);
    if (!s || s.expires < Date.now()) { sessions.delete(token); return null; }
    return { ...s, token };
  }

  function requireAuth(req, res, next) {
    const s = getSession(req);
    if (!s) return res.status(401).json({ error: 'not_logged_in' });
    req.user = s;
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
    next();
  }

  function createSession(res, user) {
    const token = crypto.randomBytes(24).toString('base64url');
    sessions.set(token, { username: user.username, role: user.role, email: user.email || '', expires: Date.now() + SESSION_TTL_MS });
    res.setHeader('Set-Cookie', `jl_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`);
    return token;
  }

  function getBaseUrl() {
    return getSetting(db, 'base_url') || 'https://v2.joblinkplatform.com';
  }

  const router = express.Router();

  // ---- Login (email OR username + password) ----
  router.post('/api/login', (req, res) => {
    const { username, email, password } = req.body || {};
    const identifier = email || username;
    if (!identifier || !password) return res.status(400).json({ error: 'email/username and password required' });
    // Try email first, then username
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(identifier));
    if (!user) user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(identifier));
    if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
      return res.status(401).json({ error: 'bad_credentials' });
    }
    createSession(res, user);
    const isDefault = (user.username === 'admin' && bcrypt.compareSync('joblink2026', user.password_hash));
    res.json({
      ok: true, username: user.username, role: user.role, email: user.email || '',
      defaultPassword: isDefault,
      needsOnboarding: user.role === 'admin' && getSetting(db, 'onboarded') !== '1',
    });
  });

  router.post('/api/logout', (req, res) => {
    const s = getSession(req);
    if (s) sessions.delete(s.token);
    res.setHeader('Set-Cookie', 'jl_session=; HttpOnly; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  router.get('/api/me', (req, res) => {
    const s = getSession(req);
    if (!s) return res.status(401).json({ error: 'not_logged_in' });
    res.json({ username: s.username, role: s.role, email: s.email, onboarded: getSetting(db, 'onboarded') === '1' });
  });

  // ---- Invite User (admin sends invitation email) ----
  router.post('/api/invite', requireAuth, (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
    const { email, role } = req.body || {};
    if (!email || !String(email).includes('@')) return res.status(400).json({ error: 'valid email required' });
    const validRole = role === 'admin' ? 'admin' : 'recruiter';
    // Check if email already exists
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email));
    if (existing) return res.status(400).json({ error: 'email already registered' });
    const inviteToken = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    // Create a placeholder user with no password (they set it on invite accept)
    const username = String(email).split('@')[0] + '_' + crypto.randomBytes(3).toString('hex');
    db.prepare(
      'INSERT INTO users (username, password_hash, role, email, email_verified, invite_token, invite_expires) VALUES (?, ?, ?, ?, 0, ?, ?)'
    ).run(username, '', validRole, String(email), inviteToken, expires);
    const baseUrl = getBaseUrl();
    const link = `${baseUrl}/invite.html?token=${inviteToken}`;
    sendEmail(String(email), 'You\'re invited to JobLink', `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px">
        <h2 style="color:#3b82f6">You're invited to JobLink</h2>
        <p>You've been invited to join JobLink as a <strong>${validRole}</strong>.</p>
        <p><a href="${link}" style="display:inline-block;background:#3b82f6;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Accept Invitation</a></p>
        <p style="color:#94a3b8;font-size:14px">This link expires in 72 hours.</p>
      </div>
    `).then(() => {
      res.json({ ok: true, message: 'Invitation sent' });
    }).catch((err) => {
      console.error('[invite-email]', err.message);
      // Still return success — the user was created, they just didn't get the email
      res.json({ ok: true, message: 'User created but email failed to send', invite_link: link });
    });
  });

  // ---- Accept Invitation (set password) ----
  router.post('/api/invite/accept', (req, res) => {
    const { token, password, display_name } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });
    if (!password || String(password).length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    const user = db.prepare('SELECT * FROM users WHERE invite_token = ?').get(String(token));
    if (!user) return res.status(404).json({ error: 'invalid or expired invitation' });
    if (new Date(user.invite_expires) < new Date()) return res.status(400).json({ error: 'invitation expired' });
    // Set password, clear invite token, mark verified
    const username = display_name ? String(display_name).toLowerCase().replace(/[^a-z0-9]/g, '') : user.username;
    db.prepare(
      'UPDATE users SET password_hash = ?, email_verified = 1, invite_token = NULL, invite_expires = NULL, display_name = ? WHERE id = ?'
    ).run(bcrypt.hashSync(String(password), 10), display_name || '', user.id);
    // Try to update username if display_name given (ignore conflict)
    if (display_name) {
      try { db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, user.id); } catch { /* username taken */ }
    }
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    createSession(res, updated);
    res.json({ ok: true, username: updated.username, role: updated.role });
  });

  // ---- Validate invite token (check if valid before showing form) ----
  router.get('/api/invite/validate', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'token required' });
    const user = db.prepare('SELECT email, role, invite_expires FROM users WHERE invite_token = ?').get(String(token));
    if (!user) return res.status(404).json({ error: 'invalid invitation' });
    if (new Date(user.invite_expires) < new Date()) return res.status(400).json({ error: 'invitation expired' });
    res.json({ ok: true, email: user.email, role: user.role });
  });

  // ---- Forgot Password (send reset link) ----
  router.post('/api/forgot-password', (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email));
    // Always return success (don't leak whether email exists)
    if (!user) return res.json({ ok: true });
    const resetToken = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + RESET_TTL_MS).toISOString();
    db.prepare('UPDATE users SET magic_login_token = ?, magic_login_expires = ? WHERE id = ?')
      .run(resetToken, expires, user.id);
    const baseUrl = getBaseUrl();
    const link = `${baseUrl}/reset-password.html?token=${resetToken}`;
    sendEmail(String(email), 'Reset your JobLink password', `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px">
        <h2 style="color:#3b82f6">Reset Your Password</h2>
        <p>Click below to reset your JobLink password.</p>
        <p><a href="${link}" style="display:inline-block;background:#3b82f6;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Reset Password</a></p>
        <p style="color:#94a3b8;font-size:14px">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
      </div>
    `).catch((err) => console.error('[reset-email]', err.message));
    res.json({ ok: true });
  });

  // ---- Reset Password (with token) ----
  router.post('/api/reset-password', (req, res) => {
    const { token, password } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });
    if (!password || String(password).length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    const user = db.prepare('SELECT * FROM users WHERE magic_login_token = ?').get(String(token));
    if (!user) return res.status(404).json({ error: 'invalid or expired reset link' });
    if (new Date(user.magic_login_expires) < new Date()) return res.status(400).json({ error: 'reset link expired' });
    db.prepare('UPDATE users SET password_hash = ?, magic_login_token = NULL, magic_login_expires = NULL WHERE id = ?')
      .run(bcrypt.hashSync(String(password), 10), user.id);
    res.json({ ok: true });
  });

  // ---- Magic Link Login (send one-time login link) ----
  router.post('/api/magic-login', (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email));
    if (!user) return res.json({ ok: true }); // don't leak
    const magicToken = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + MAGIC_TTL_MS).toISOString();
    db.prepare('UPDATE users SET magic_login_token = ?, magic_login_expires = ? WHERE id = ?')
      .run(magicToken, expires, user.id);
    const baseUrl = getBaseUrl();
    const link = `${baseUrl}/api/magic-login/verify?token=${magicToken}`;
    sendEmail(String(email), 'Sign in to JobLink', `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px">
        <h2 style="color:#3b82f6">Sign In to JobLink</h2>
        <p>Click below to sign in. No password needed.</p>
        <p><a href="${link}" style="display:inline-block;background:#3b82f6;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Sign In</a></p>
        <p style="color:#94a3b8;font-size:14px">This link expires in 15 minutes.</p>
      </div>
    `).catch((err) => console.error('[magic-login-email]', err.message));
    res.json({ ok: true });
  });

  // ---- Magic Link Verify (GET — clicked from email) ----
  router.get('/api/magic-login/verify', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('Invalid link');
    const user = db.prepare('SELECT * FROM users WHERE magic_login_token = ?').get(String(token));
    if (!user || new Date(user.magic_login_expires) < new Date()) {
      return res.status(400).send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Link expired or invalid</h2><p><a href="/login.html">Go to login</a></p></body></html>');
    }
    // Clear token, create session, redirect
    db.prepare('UPDATE users SET magic_login_token = NULL, magic_login_expires = NULL, email_verified = 1 WHERE id = ?')
      .run(user.id);
    createSession(res, user);
    res.redirect('/tom.html');
  });

  return { router, requireAuth, requireAdmin, sessions };
}

module.exports = { createAuth, sendEmail };
