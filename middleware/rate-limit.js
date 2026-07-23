// Per-org API rate limiting. Runs AFTER auth so req.user.org_id is available.
// IP-based limiters for unauthenticated routes (login, forgot-password).
// Org-based limiters for authenticated API routes.
// Blast-specific limiter to prevent accidental mass sends.

const rateLimit = require('express-rate-limit');

// Behind Cloudflare + Traefik — trust proxy is set, req.ip is reliable.
// Disable keyGeneratorIpFallback validation (false positive on org-keyed limiters).
const COMMON = { standardHeaders: true, legacyHeaders: false, validate: { keyGeneratorIpFallback: false } };

// ---- IP-based limiters (unauthenticated routes) ----

const loginLimiter = rateLimit({
  ...COMMON,
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'rate_limited', message: 'Too many login attempts. Please try again in a minute.' },
});

const forgotPasswordLimiter = rateLimit({
  ...COMMON,
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'rate_limited', message: 'Too many password reset requests. Please try again in a minute.' },
});

// ---- Org-based limiters (authenticated routes) ----

const orgRateLimiter = rateLimit({
  ...COMMON,
  windowMs: 60 * 1000,           // 1 minute window
  max: 500,                       // 500 requests per minute per org
  keyGenerator: (req) => {
    // After auth middleware, req.user.org_id is available.
    return req.user?.org_id ? `org:${req.user.org_id}` : `org:anon`;
  },
  message: {
    error: 'rate_limited',
    message: 'Your organization has exceeded the API rate limit. Please try again shortly.',
  },
});

const orgBlastLimiter = rateLimit({
  ...COMMON,
  windowMs: 60 * 60 * 1000,     // 1 hour window
  max: 10,                       // 10 blast executions per hour per org
  keyGenerator: (req) => {
    return req.user?.org_id ? `blast:${req.user.org_id}` : `blast:anon`;
  },
  message: {
    error: 'rate_limited',
    message: 'Your organization has exceeded the blast rate limit (10 per hour). Please try again later.',
  },
});

module.exports = {
  loginLimiter,
  forgotPasswordLimiter,
  orgRateLimiter,
  orgBlastLimiter,
};
