// Messaging boundary — the swappable seam (PROJECT_BRIEF §17, BUILD_PROMPT §12).
// Whippy today, Relay tomorrow. Core logic (Blast Guard, blasts, job orders)
// only ever sees this interface:
//
//   provider.name
//   provider.sendSms({ to, body })            → { ok, conversationId?, error? }
//   provider.testConnection()                 → { ok, error? }
//   provider.closeOpenConversations?()        → { closed }   (extension point)
//
// Swapping providers = adding one file here + one settings value. Zero changes
// to blast/guard/job-order code — that's the contract, and tests enforce that
// core modules never import whippy directly.

const { getSetting } = require('../db');
const whippy = require('./whippy');
const mock = require('./mock');

/**
 * Get messaging provider. Accepts optional overrides for multi-number support.
 * @param {object} db - tenant database
 * @param {object} [overrides] - { fromNumber, channelId } to override defaults
 */
function getProvider(db, overrides) {
  const name = getSetting(db, 'sms_provider') || 'mock';
  if (name === 'whippy') {
    const config = {
      apiKey: getSetting(db, 'whippy_api_key'),
      channelId: (overrides && overrides.channelId) || getSetting(db, 'whippy_channel_id'),
      fromNumber: (overrides && overrides.fromNumber) || getSetting(db, 'whippy_from_number'),
    };
    if (config.apiKey && config.channelId && config.fromNumber) return whippy.create(config);
    return mock.create({ reason: 'whippy_not_configured' });
  }
  // Future: if (name === 'relay') return relay.create(...)
  return mock.create({});
}

/**
 * Resolve sending number config from whippy_numbers or single-number fallback.
 * Returns { fromNumber, channelId } or null if nothing configured.
 */
function resolveNumber(db, selectedFromNumber) {
  // If a specific number was selected, look it up in whippy_numbers
  if (selectedFromNumber) {
    const raw = getSetting(db, 'whippy_numbers');
    if (raw) {
      try {
        const numbers = JSON.parse(raw);
        const match = numbers.find(n => n.from_number === selectedFromNumber);
        if (match) return { fromNumber: match.from_number, channelId: match.channel_id };
      } catch { /* ignore */ }
    }
  }
  // Fallback to single-number settings
  const fromNumber = getSetting(db, 'whippy_from_number');
  const channelId = getSetting(db, 'whippy_channel_id');
  if (fromNumber && channelId) return { fromNumber, channelId };
  return null;
}

module.exports = { getProvider, resolveNumber };
