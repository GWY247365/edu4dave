// Cross-device progress sync backed by Upstash Redis (REST API).
// Stores one JSON blob per family code. Dumb key-value store; the client
// does the pull-merge-push reconciliation.
//
// Safety net (added after a real data-loss incident):
//  - Before a write replaces the stored blob, the previous version is kept as
//    a backup: at most one per UTC day, last 14 kept, plus a forced backup
//    before any destructive write (reset or restore).
//  - A write that would erase most of the stored progress is refused unless
//    the client says it means to (allowShrink — only the parent's Reset sends
//    it). Merged writes never shrink attempt counts, so a big drop can only
//    be a blank or damaged device, not practice.
//  - GET ?code=…&backups=1 lists backups; POST { code, restore: i } restores
//    one (backing up the current version first).
export const config = { maxDuration: 10 };

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const MAX_BACKUPS = 14;

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

// How much practice a blob represents. Merges take the max of every count,
// so legitimate writes never make this go down.
function progressWeight(d) {
  if (!d || typeof d !== 'object') return 0;
  let n = 0;
  for (const group of [d.facts, d.divFacts, d.skills, d.buckets]) {
    if (!group) continue;
    for (const k in group) {
      const f = group[k];
      if (f) n += (f.right || 0) + (f.wrong || 0);
    }
  }
  return n + (Array.isArray(d.hist) ? d.hist.length : 0);
}

function summarize(d) {
  const hist = (d && Array.isArray(d.hist)) ? d.hist : [];
  const last = hist.length ? hist[hist.length - 1].d : null;
  const facts = d && d.facts ? Object.keys(d.facts).length : 0;
  return { quizzes: hist.length, lastPractice: last, factsSeen: facts, weight: progressWeight(d),
           streakBest: (d && d.streak && d.streak.best) || 0 };
}

function utcDay(ts) { return new Date(ts).toISOString().slice(0, 10); }

// Keep the version that is about to be replaced. Daily granularity unless
// forced, so a week of twice-a-day syncs still leaves two weeks of history.
async function backupCurrent(code, currentRaw, force) {
  if (!currentRaw) return false;
  const key = `progress:${code}:bak`;
  const now = Date.now();
  if (!force) {
    const newest = await redis(['LINDEX', key, 0]);
    if (newest) {
      try { if (JSON.parse(newest).day === utcDay(now)) return false; } catch {}
    }
  }
  let data;
  try { data = JSON.parse(currentRaw); } catch { return false; }
  await redis(['LPUSH', key, JSON.stringify({ ts: now, day: utcDay(now), data })]);
  await redis(['LTRIM', key, 0, MAX_BACKUPS - 1]);
  return true;
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
      if (req.query.backups) {
        const list = (await redis(['LRANGE', `progress:${code}:bak`, 0, MAX_BACKUPS - 1])) || [];
        const backups = list.map((raw, i) => {
          try { const b = JSON.parse(raw); return { i, ts: b.ts, ...summarize(b.data) }; }
          catch { return { i, ts: null, broken: true }; }
        });
        res.status(200).json({ backups });
        return;
      }
      const val = await redis(['GET', `progress:${code}`]);
      res.status(200).json({ data: val ? JSON.parse(val) : null });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      const code = sanitize(body && body.code);
      if (code.length < 3) { res.status(400).json({ error: 'bad code' }); return; }

      const current = await redis(['GET', `progress:${code}`]);

      // Restore a backup: keep what is there now, then put the backup back.
      if (body && Number.isInteger(body.restore)) {
        const raw = await redis(['LINDEX', `progress:${code}:bak`, body.restore]);
        if (!raw) { res.status(404).json({ error: 'no such backup' }); return; }
        const b = JSON.parse(raw);
        await backupCurrent(code, current, true);
        await redis(['SET', `progress:${code}`, JSON.stringify(b.data)]);
        res.status(200).json({ ok: true, restored: b.ts, data: b.data });
        return;
      }

      if (!body || !body.data) { res.status(400).json({ error: 'missing data' }); return; }
      const payload = JSON.stringify(body.data);
      if (payload.length > 200000) { res.status(413).json({ error: 'data too large' }); return; }
      if (current === payload) { res.status(200).json({ ok: true, unchanged: true }); return; }

      if (current) {
        let before = 0;
        try { before = progressWeight(JSON.parse(current)); } catch {}
        const after = progressWeight(body.data);
        const shrinking = before >= 30 && after < before * 0.5;
        if (shrinking && !body.allowShrink) {
          res.status(409).json({
            error: 'refused: this write would erase most of the saved progress',
            reason: 'shrink', before, after,
          });
          return;
        }
        await backupCurrent(code, current, shrinking);
      }
      await redis(['SET', `progress:${code}`, payload]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'progress failed' });
  }
}
