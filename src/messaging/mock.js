// Mock provider — used in tests and whenever real credentials aren't
// configured. Records every send in memory; never touches the network.
// Also the safety default: a fresh install can never accidentally text
// real people (sms_provider defaults to 'mock').

function create(opts = {}) {
  const sent = [];
  return {
    name: 'mock',
    reason: opts.reason || null,
    sent, // exposed for tests and dry-run inspection
    failNumbers: new Set(opts.failNumbers || []), // simulate partial-send failures in tests
    async sendSms({ to, body }) {
      if (this.failNumbers.has(to)) return { ok: false, error: 'simulated failure' };
      sent.push({ to, body, at: new Date().toISOString() });
      return { ok: true, conversationId: `mock-${sent.length}` };
    },
    async testConnection() {
      return { ok: true, mock: true };
    },
    async closeOpenConversations() {
      return { closed: 0 };
    },
  };
}

module.exports = { create };
