// Password enforcement middleware — simple one-time gate.
// On enforcement day: every user must set a new complex password.
// After that: only new users are enforced at signup/invite time.
// No rolling expiration. One reset, done.

const ENFORCEMENT_DATE = new Date('2026-11-01T00:00:00-05:00'); // Nov 1, midnight CT

const ALLOWED_WHEN_EXPIRED = [
  { method: 'POST', path: '/api/me/password' },
  { method: 'POST', path: '/api/logout' },
  { method: 'GET',  path: '/api/me' },
];

function passwordExpiryMiddleware(sysDb) {
  return (req, res, next) => {
    if (!req.originalUrl.startsWith('/api/') || !req.user || !req.user.user_id) return next();

    for (const allowed of ALLOWED_WHEN_EXPIRED) {
      if (req.method === allowed.method && req.originalUrl.startsWith(allowed.path)) return next();
    }

    const now = new Date();
    if (now < ENFORCEMENT_DATE) return next();

    const user = sysDb.prepare('SELECT password_changed_at FROM users WHERE id = ?').get(req.user.user_id);
    if (!user) return next();

    const changedAt = user.password_changed_at ? new Date(user.password_changed_at) : null;

    // If password was never changed, or changed before enforcement date -> must reset
    if (!changedAt || changedAt < ENFORCEMENT_DATE) {
      return res.status(403).json({
        error: 'password_expired',
        message: 'Please set a new password meeting our security requirements.',
        redirect: '/change-password',
      });
    }

    // Password set after enforcement date -> good to go, no rolling clock
    next();
  };
}

module.exports = { passwordExpiryMiddleware, ENFORCEMENT_DATE };
