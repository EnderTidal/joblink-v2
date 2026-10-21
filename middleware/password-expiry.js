// Password expiration middleware — enforcement-date-gated.
// Before ENFORCEMENT_DATE: gate is OFF, nobody blocked.
// On/after ENFORCEMENT_DATE: passwords set before that date are forced to reset,
// then rolling 30-day clock from the reset moment.

const ENFORCEMENT_DATE = new Date('2026-11-01T00:00:00-05:00'); // pushed from Oct 21 — change-password page not ready // Wed Oct 14, midnight CDT
const PASSWORD_MAX_AGE_DAYS = 30;

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

    // Before enforcement date: gate is OFF
    if (now < ENFORCEMENT_DATE) return next();

    const user = sysDb.prepare('SELECT password_changed_at FROM users WHERE id = ?').get(req.user.user_id);
    if (!user) return next();

    const changedAt = user.password_changed_at ? new Date(user.password_changed_at) : new Date(0);

    // Password set before enforcement date -> blocked (universal reset)
    if (changedAt < ENFORCEMENT_DATE) {
      return res.status(403).json({
        error: 'password_expired',
        message: 'Your password has expired. Please change your password to continue.',
        redirect: '/change-password',
      });
    }

    // Password set after enforcement date — check rolling 30-day clock
    const ageDays = Math.floor((now.getTime() - changedAt.getTime()) / (1000 * 60 * 60 * 24));
    if (ageDays >= PASSWORD_MAX_AGE_DAYS) {
      return res.status(403).json({
        error: 'password_expired',
        message: 'Your password has expired. Please change your password to continue.',
        redirect: '/change-password',
      });
    }

    next();
  };
}

module.exports = { passwordExpiryMiddleware, PASSWORD_MAX_AGE_DAYS, ENFORCEMENT_DATE };
