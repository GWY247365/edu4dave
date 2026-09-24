// Daily rate limits for the paid AI endpoints (/api/plan, /api/teach).
// Files starting with "_" are not exposed as routes by Vercel.
//
// Both endpoints spend money on every call and neither needs a login, so a
// scripted caller could otherwise run up the bill without bound. Two counters
// per endpoint per UTC day, kept in the Upstash instance sync already uses:
//   - per client IP: generous for a family, tight for a script
//   - global: a hard ceiling on the day's spend whatever the IP spread
//
// Fails OPEN: if Redis is not configured or errors, the call goes through.
// The limiter exists to cap abuse, not to take the feature down for the
// family when a dependency hiccups.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

export const LIMITS = {
  plan:  { perIp: 20, global: 100 },   // a weekly report — 20/day is far above real use
  teach: { perIp: 60, global: 400 },   // one per missed question at most
};

async function redis(command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  return (await res.json()).result;
}

async function bump(key) {
  const n = await redis(['INCR', key]);
  if (n === 1) await redis(['EXPIRE', key, 90000]); // 25h: outlives the UTC day
  return n;
}

export function clientIp(req) {
  const h = (req && req.headers) || {};
  const fwd = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || String(h['x-real-ip'] || '').trim() || 'unknown').slice(0, 64);
}

// Returns null when the call may proceed, or { status, body } to send back.
export async function checkLimit(endpoint, req, now = Date.now()) {
  const lim = LIMITS[endpoint];
  if (!lim || !REDIS_URL || !REDIS_TOKEN) return null;
  const day = new Date(now).toISOString().slice(0, 10);
  try {
    const [ip, all] = await Promise.all([
      bump(`rl:${endpoint}:ip:${clientIp(req)}:${day}`),
      bump(`rl:${endpoint}:all:${day}`),
    ]);
    if (ip > lim.perIp || all > lim.global) {
      return {
        status: 429,
        body: {
          error: 'Daily limit reached for AI help — it resets tomorrow.',
          reason: ip > lim.perIp ? 'ip' : 'global',
        },
      };
    }
    return null;
  } catch {
    return null; // fail open
  }
}
