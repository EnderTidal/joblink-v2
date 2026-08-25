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
          from: toE164(config.fromNumber),
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
        const result = await whippyRequest(config, 'GET', '/v1/conversations?limit=1000', null);
        return (result?.data || []).filter(c => c.status === 'open').map(c => c.id);
      } catch(e) { return []; }
    },

    async assignAndCloseNewConversations(recruiterId, preBlastIds) {
      try {
        const pre = preBlastIds || new Set();
        const result = await whippyRequest(config, 'GET', '/v1/conversations?limit=1000&status=open', null);
        const allOpen = (result?.data || []).filter(c => c.status === 'open');
        const newConvos = allOpen.filter(c => !pre.has(c.id));
        console.log("[whippy] assignAndClose: total open:", allOpen.length, "preBlast:", pre.size, "new:", newConvos.length, "recruiterId:", recruiterId);
        let assigned = 0, closed = 0;
        for (const c of newConvos) {
          try {
            // Combine assign + close in a single PATCH
            const patchBody = { status: 'closed' };
            if (recruiterId) patchBody.assigned_user_id = Number(recruiterId);
            console.log('[whippy] PATCH /v1/conversations/' + c.id, JSON.stringify(patchBody));
            const patchResult = await whippyRequest(config, 'PATCH', '/v1/conversations/' + c.id, patchBody);
            console.log('[whippy] PATCH result:', JSON.stringify({ id: patchResult?.data?.id || patchResult?.id, assigned: patchResult?.data?.assigned_user_id || patchResult?.assigned_user_id, status: patchResult?.data?.status || patchResult?.status }));
            closed++;
            if (recruiterId) assigned++;
          } catch(e) { console.error('[whippy] assign+close failed:', c.id, e.message); }
        }
        return { assigned, closed, total: allOpen.length, newOnly: newConvos.length };
      } catch(e) { return { assigned: 0, closed: 0 }; }
    },
    async _patchConversation(conversationId, body) {
      return whippyRequest(config, 'PATCH', '/v1/conversations/' + conversationId, body);
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
        const result = await whippyRequest(config, 'GET', '/v1/conversations?limit=1000', null);
        const convos = (result?.data || []).filter(c => c.status === 'open');
        let assigned = 0, closed = 0;
        for (const c of convos) {
          try {
            const patchBody = { status: 'closed' };
            if (recruiterId) patchBody.assigned_user_id = recruiterId;
            await whippyRequest(config, 'PATCH', '/v1/conversations/' + c.id, patchBody);
            closed++;
            if (recruiterId) assigned++;
          } catch(e) { console.error('[whippy] assign+close failed:', c.id, e.message); }
        }
        return { assigned, closed };
      } catch(e) {
        return { assigned: 0, closed: 0, error: e.message };
      }
    },
    async closeOpenConversations() {
      try {
        const result = await whippyRequest(config, 'GET', '/v1/conversations?limit=100', null);
        const convos = (result.data || []).filter(c => c.status === 'open');
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
