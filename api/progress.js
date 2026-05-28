// Cross-device progress sync backed by Upstash Redis (REST API).
// Stores one JSON blob per family code. Dumb key-value store; the client
// does the pull-merge-push reconciliation.
export const config = { maxDuration: 10 };

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

function sanitize(code) {
  return String(code || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64);
}

async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`redis ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()).result;
}

export default async function handler(req, res) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    res.status(500).json({ error: 'Server missing Upstash config (UPSTASH_REDIS_REST_URL/TOKEN)' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const code = sanitize(req.query.code);
      if (code.length < 3) { res.status(400).json({ error: 'bad code' }); return; }
      const val = await redis(['GET', `progress:${code}`]);
      res.status(200).json({ data: val ? JSON.parse(val) : null });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      const code = sanitize(body && body.code);
      if (code.length < 3) { res.status(400).json({ error: 'bad code' }); return; }
      if (!body || !body.data) { res.status(400).json({ error: 'missing data' }); return; }
      const payload = JSON.stringify(body.data);
      if (payload.length > 200000) { res.status(413).json({ error: 'data too large' }); return; }
      await redis(['SET', `progress:${code}`, payload]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'progress failed' });
  }
}
