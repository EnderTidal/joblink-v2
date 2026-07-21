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

function getProvider(db) {
  const name = getSetting(db, 'sms_provider') || 'mock';
  if (name === 'whippy') {
    const config = {
      apiKey: getSetting(db, 'whippy_api_key'),
      channelId: getSetting(db, 'whippy_channel_id'),
      fromNumber: getSetting(db, 'whippy_from_number'),
    };
    if (config.apiKey && config.channelId && config.fromNumber) return whippy.create(config);
    return mock.create({ reason: 'whippy_not_configured' });
  }
  // Future: if (name === 'relay') return relay.create(...)
  return mock.create({});
}

module.exports = { getProvider };
