// Tests for the AI endpoints' rate limiting (api/_ratelimit.js wired into
// api/plan.js and api/teach.js), against in-memory stand-ins for Upstash and
// the Hunyuan chat API. Run with: node test/ratelimit.mjs
process.env.UPSTASH_REDIS_REST_URL = 'http://fake-redis';
process.env.UPSTASH_REDIS_REST_TOKEN = 't';
process.env.HUNYUAN_API_KEY = 'k';
process.env.HUNYUAN_BASE_URL = 'http://fake-model';

const kv = new Map();
let modelCalls = 0, lastModelPrompt = '', redisDown = false;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('http://fake-model')) {
    modelCalls++;
    lastModelPrompt = JSON.parse(init.body).messages.map(m => m.content).join('\n');
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'a lesson' } }] }), text: async () => '' };
  }
  if (redisDown) return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
  const [cmd, key, ...args] = JSON.parse(init.body);
  let result = null;
  if (cmd === 'INCR') { result = (kv.get(key) || 0) + 1; kv.set(key, result); }
  else if (cmd === 'EXPIRE') result = 1;
  return { ok: true, json: async () => ({ result }), text: async () => '' };
};

const { default: plan } = await import(new URL('../api/plan.js', import.meta.url));
const { default: teach } = await import(new URL('../api/teach.js', import.meta.url));
const { LIMITS } = await import(new URL('../api/_ratelimit.js', import.meta.url));

const call = async (handler, body, ip = '1.1.1.1') => {
  let status = 200, out;
  const res = { status(s) { status = s; return this; }, json(o) { out = o; } };
  await handler({ method: 'POST', body, headers: { 'x-forwarded-for': ip + ', 10.0.0.1' } }, res);
  return { status, out };
};
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!ok) fails++; };
const planBody = { stats: { quizzesDone: 1 } };
const teachBody = { problem: { type: 'mul', a: 7, b: 8 } };

console.log('1) per-IP daily limit');
let r;
for (let i = 0; i < LIMITS.plan.perIp; i++) r = await call(plan, planBody);
check(`first ${LIMITS.plan.perIp} plan calls succeed`, r.status === 200);
const before = modelCalls;
r = await call(plan, planBody);
check('next call from the same IP gets 429', r.status === 429 && r.out.reason === 'ip', JSON.stringify(r.out));
check('a blocked call never reaches the paid model', modelCalls === before);
r = await call(plan, planBody, '2.2.2.2');
check('another IP is still served', r.status === 200);

console.log('2) global daily ceiling');
kv.clear();
let lastOk = 0;
for (let i = 0; i < LIMITS.teach.global + 5; i++) {
  r = await call(teach, teachBody, `9.9.${Math.floor(i / 250)}.${i % 250}`); // spread over many IPs
  if (r.status === 200) lastOk = i + 1;
}
check(`global cap holds across many IPs (${LIMITS.teach.global})`, lastOk === LIMITS.teach.global && r.status === 429 && r.out.reason === 'global', `served ${lastOk}`);

console.log('3) malformed requests do not use up the allowance');
kv.clear();
for (let i = 0; i < 100; i++) await call(teach, { problem: { type: 'nope' } });
r = await call(teach, teachBody);
check('valid call still served after 100 bad ones', r.status === 200);

console.log('4) fails open if Redis is unavailable');
redisDown = true;
r = await call(plan, planBody);
check('plan still works with Redis down', r.status === 200);
redisDown = false;

console.log('5) word problems are accepted by Teach me this');
kv.clear();
r = await call(teach, { problem: { type: 'word', text: 'Sam has 75 cards. Sam has 28 more cards than Leo. How many cards does Leo have?', op: '75 − 28', ans: 47 } });
check('word problem gets a lesson', r.status === 200 && r.out.lesson === 'a lesson');
check('prompt carries the story and the plan', /Sam has 75 cards/.test(lastModelPrompt) && /75 − 28 = 47/.test(lastModelPrompt));
r = await call(teach, { problem: { type: 'word', text: 'x'.repeat(401), op: '1 + 1', ans: 2 } });
check('oversized story is rejected before any model call', r.status === 400);

console.log('6) long division is accepted by Teach me this, but only if the numbers add up');
kv.clear();
r = await call(teach, { problem: { type: 'ldiv', a: 624, b: 6, q: 104, r: 0 } });
check('long division gets a lesson', r.status === 200 && r.out.lesson === 'a lesson');
check('prompt carries the answer and the zero rule', /104 remainder 0/.test(lastModelPrompt) && /write a 0/.test(lastModelPrompt));
r = await call(teach, { problem: { type: 'ldiv', a: 47, b: 6, q: 6, r: 11 } });
check('a remainder not smaller than the divisor is rejected', r.status === 400);
r = await call(teach, { problem: { type: 'ldiv', a: 50, b: 6, q: 7, r: 5 } });
check('numbers that do not add up are rejected', r.status === 400);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall rate-limit tests passed');
process.exit(fails ? 1 : 0);
