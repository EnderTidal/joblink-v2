// Password complexity validation — shared across auth routes.

function validatePassword(pw) {
  if (!pw || typeof pw !== 'string') return { valid: false, errors: ['Password is required'] };
  const errors = [];
  if (pw.length < 12) errors.push('Password must be at least 12 characters');
  if (!/[A-Z]/.test(pw)) errors.push('Password must contain at least one uppercase letter');
  if (!/[a-z]/.test(pw)) errors.push('Password must contain at least one lowercase letter');
  if (!/[0-9]/.test(pw)) errors.push('Password must contain at least one number');
  if (!/[^A-Za-z0-9]/.test(pw)) errors.push('Password must contain at least one special character');
  return { valid: errors.length === 0, errors };
}

module.exports = { validatePassword };
