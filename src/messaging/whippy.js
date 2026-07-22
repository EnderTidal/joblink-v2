// Whippy provider — ported from V1 (lib/whippy.js): pure API client, no DB
// knowledge. Config: { apiKey, channelId, fromNumber }.
const https = require('node:https');
const { toE164 } = require('../phone');

const WHIPPY_BASE = 'api.whippy.co';

function whippyRequest(config, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: WHIPPY_BASE,
      port: 443,
      path,
      method,
      headers: {
        'X-WHIPPY-KEY': config.apiKey,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(out);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`Whippy ${res.statusCode}: ${out}`));
        } catch {
          reject(new Error(`Whippy parse error: ${out}`));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function create(config) {
  return {
    name: 'whippy',
    async sendSms({ to, body }) {
      try {
        const res = await whippyRequest(config, 'POST', '/v1/messaging/sms', {
          to: toE164(to),
          from: config.fromNumber,
          body,
          channel_id: config.channelId,
        });
        return { ok: true, conversationId: res?.data?.conversation_id || null };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    async testConnection() {
      try {
        await whippyRequest(config, 'GET', '/v1/contacts?limit=1', null);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    // Ported V1 behavior: a blast opens conversation threads in Whippy;
    // close them back out to keep the inbox clean (PORTING_FROM_V1.md).


    async getOpenConversationIds() {
      try {
        const result = await whippyRequest(config, 'GET', '/v1/conversations?limit=300&status=open', null);
        return (result?.data || []).map(c => c.id);
      } catch(e) { return []; }
    },

    async assignAndCloseNewConversations(recruiterId, preBlastIds) {
      try {
        const pre = preBlastIds || new Set();
        const result = await whippyRequest(config, 'GET', '/v1/conversations?limit=300&status=open', null);
        const allOpen = result?.data || [];
        const newConvos = allOpen.filter(c => !pre.has(c.id));
        let assigned = 0, closed = 0;
        for (const c of newConvos) {
          if (recruiterId) {
            try { await whippyRequest(config, 'PATCH', '/v1/conversations/' + c.id, { assigned_user_id: recruiterId }); assigned++; } catch(e) {}
          }
          try { await whippyRequest(config, 'PATCH', '/v1/conversations/' + c.id, { status: 'closed' }); closed++; } catch(e) {}
        }
        return { assigned, closed, total: allOpen.length, newOnly: newConvos.length };
      } catch(e) { return { assigned: 0, closed: 0 }; }
    },
    async assignConversation(conversationId, userId) {
      try {
        await whippyRequest(config, 'PATCH', '/v1/conversations/' + conversationId, { assigned_user_id: userId });
        return { ok: true };
      } catch(e) {
        return { ok: false, error: e.message };
      }
    },

    async assignAndCloseConversations(recruiterId) {
      try {
        const result = await whippyRequest(config, 'GET', '/v1/conversations?limit=100&status=open', null);
        const convos = result?.data || [];
        let assigned = 0, closed = 0;
        for (const c of convos) {
          if (recruiterId) {
            await whippyRequest(config, 'PATCH', '/v1/conversations/' + c.id, { assigned_user_id: recruiterId });
            assigned++;
          }
          await whippyRequest(config, 'PATCH', '/v1/conversations/' + c.id, { status: 'closed' });
          closed++;
        }
        return { assigned, closed };
      } catch(e) {
        return { assigned: 0, closed: 0, error: e.message };
      }
    },
    async closeOpenConversations() {
      try {
        const result = await whippyRequest(config, 'GET', '/v1/conversations?limit=100', null);
        const convos = result.data || [];
        let closed = 0;
        for (const c of convos) {
          try {
            await whippyRequest(config, 'PATCH', '/v1/conversations/' + c.id, { status: 'closed' });
            closed++;
          } catch { /* best-effort */ }
        }
        return { closed };
      } catch {
        return { closed: 0 };
      }
    },
  };
}

module.exports = { create };
