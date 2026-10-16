// src/translate.js — fire-and-forget Spanish translation for job orders
// Extracted from scripts/migrate-spanish-translations.js

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

async function translateAndSave(db, jobOrderId) {
  if (!ANTHROPIC_API_KEY) return; // silent skip if no key

  try {
    const jo = db.prepare('SELECT id, title, description, requirements FROM job_orders WHERE id = ?').get(jobOrderId);
    if (!jo) return;
    if (!jo.title && !jo.description && !jo.requirements) return;

    const prompt = `Translate the following job posting to Spanish. Keep it professional and natural — this is for blue-collar staffing candidates. Return ONLY valid JSON with keys: title_es, description_es, requirements_es. No markdown, no code fences.

Title: ${jo.title || '(none)'}

Description: ${jo.description || '(none)'}

Requirements: ${jo.requirements || '(none)'}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      console.error(`[translate] Anthropic API ${resp.status} for JO #${jobOrderId}`);
      return;
    }

    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const es = JSON.parse(cleaned);

    db.prepare(
      `UPDATE job_orders SET title_es = ?, description_es = ?, requirements_es = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).run(es.title_es || '', es.description_es || '', es.requirements_es || '', jobOrderId);

    console.log(`[translate] JO #${jobOrderId} translated: "${es.title_es}"`);
  } catch (err) {
    console.error(`[translate] JO #${jobOrderId} failed:`, err.message);
  }
}

module.exports = { translateAndSave };
