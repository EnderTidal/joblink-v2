// Auth — deliberately small: bcrypt passwords, random session tokens in an
// http-only cookie. First boot seeds admin/joblink2026 (change it in Admin →
// Users — the UI nags until you do).

const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { getSetting } = require('../src/db');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function createAuth(db) {
  const sessions = new Map(); // token → { username, role, expires }

  // Seed a first admin if the users table is empty
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count === 0) {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run('admin', bcrypt.hashSync('joblink2026', 10), 'admin');
    console.log('[auth] Seeded default admin — username: admin, password: joblink2026 (CHANGE THIS in Admin → Users)');
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

  const router = express.Router();

  router.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
    if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
      return res.status(401).json({ error: 'bad_credentials' });
    }
    const token = crypto.randomBytes(24).toString('base64url');
    sessions.set(token, { username: user.username, role: user.role, expires: Date.now() + SESSION_TTL_MS });
    res.setHeader('Set-Cookie', `jl_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.json({ ok: true, username: user.username, role: user.role,
      defaultPassword: username === 'admin' && password === 'joblink2026',
      needsOnboarding: user.role === 'admin' && getSetting(db, 'onboarded') !== '1' });
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
    res.json({ username: s.username, role: s.role, onboarded: getSetting(db, 'onboarded') === '1' });
  });

  return { router, requireAuth, requireAdmin, sessions };
}

module.exports = { createAuth };
