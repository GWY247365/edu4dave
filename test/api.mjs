// Server-side tests for api/progress.js against an in-memory Upstash stand-in:
// daily backups, the anti-wipe guard, allowShrink for resets, restore.
// Run with: node test/api.mjs
process.env.UPSTASH_REDIS_REST_URL = 'http://fake-redis';
process.env.UPSTASH_REDIS_REST_TOKEN = 't';
// In-memory Upstash REST stand-in
const kv = new Map();
let clock = Date.parse('2026-09-24T08:00:00Z');
const realNow = Date.now; Date.now = () => clock;
globalThis.fetch = async (url, init) => {
  const [cmd, key, ...args] = JSON.parse(init.body);
  let result = null;
  const list = () => (kv.get(key) || []);
  switch (cmd) {
    case 'GET': result = kv.get(key) ?? null; break;
    case 'SET': kv.set(key, args[0]); result = 'OK'; break;
    case 'LPUSH': kv.set(key, [args[0], ...list()]); result = list().length; break;
    case 'LTRIM': kv.set(key, list().slice(args[0], args[1] + 1)); result = 'OK'; break;
    case 'LINDEX': result = list()[args[0]] ?? null; break;
    case 'LRANGE': result = list().slice(args[0], args[1] + 1); break;
  }
  return { ok: true, json: async () => ({ result }), text: async () => '' };
};
const { default: handler } = await import(new URL('../api/progress.js', import.meta.url));
const call = async (method, { query = {}, body } = {}) => {
  let status = 200, out;
  const res = { status(s) { status = s; return this; }, json(o) { out = o; } };
  await handler({ method, query, body }, res);
  return { status, out };
};
const profile = (quizzes, attempts) => ({
  hist: Array.from({ length: quizzes }, (_, i) => ({ d: clock - i * 1000, n: 10, c: 9 })),
  facts: { '7x8': { right: attempts, wrong: 0 } }, streak: { best: 43 },
});
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fails++; };

console.log('1) 正常写入 + 每日备份');
check('first write ok', (await call('POST', { body: { code: 'fam', data: profile(80, 200) } })).status === 200);
await call('POST', { body: { code: 'fam', data: profile(81, 205) } });
await call('POST', { body: { code: 'fam', data: profile(82, 210) } });
let b = (await call('GET', { query: { code: 'fam', backups: 1 } })).out.backups;
check('same day → only one backup', b.length === 1, `backups=${b.length}`);
clock += 86400000;
await call('POST', { body: { code: 'fam', data: profile(84, 220) } });
b = (await call('GET', { query: { code: 'fam', backups: 1 } })).out.backups;
check('next day → second backup', b.length === 2, `backups=${b.length}`);
check('backup summary readable', b[0].quizzes === 82 && b[0].weight > 0, JSON.stringify(b[0]));

console.log('2) 防抹除守卫');
const wipe = await call('POST', { body: { code: 'fam', data: profile(2, 2) } });
check('near-blank write refused with 409', wipe.status === 409 && wipe.out.reason === 'shrink', JSON.stringify(wipe.out));
const still = (await call('GET', { query: { code: 'fam' } })).out.data;
check('stored data untouched after refusal', still.hist.length === 84);

console.log('3) 家长 Reset(allowShrink) 仍可执行,且强制留备份');
const before = (await call('GET', { query: { code: 'fam', backups: 1 } })).out.backups.length;
const reset = await call('POST', { body: { code: 'fam', data: profile(0, 0), allowShrink: true } });
const after = (await call('GET', { query: { code: 'fam', backups: 1 } })).out.backups;
check('reset accepted', reset.status === 200);
check('forced backup taken even on the same day', after.length === before + 1, `${before} → ${after.length}`);
check('newest backup holds the pre-reset data', after[0].quizzes === 84);

console.log('4) 恢复');
const r = await call('POST', { body: { code: 'fam', restore: 0 } });
check('restore ok and returns data', r.status === 200 && r.out.data.hist.length === 84);
check('main key holds restored data', (await call('GET', { query: { code: 'fam' } })).out.data.hist.length === 84);
const afterRestore = (await call('GET', { query: { code: 'fam', backups: 1 } })).out.backups;
check('the blank state it replaced was backed up too', afterRestore[0].quizzes === 0);
check('restore of missing index → 404', (await call('POST', { body: { code: 'fam', restore: 99 } })).status === 404);

console.log('5) 边界');
check('unchanged write is a no-op', (await call('POST', { body: { code: 'fam', data: (await call('GET', { query: { code: 'fam' } })).out.data } })).out.unchanged === true);
check('small new profile can still write (weight < 30 never guarded)', (await call('POST', { body: { code: 'new1', data: profile(1, 1) } })).status === 200
  && (await call('POST', { body: { code: 'new1', data: profile(0, 0) } })).status === 200);
check('backups capped at 14', await (async () => {
  for (let i = 0; i < 20; i++) { clock += 86400000; await call('POST', { body: { code: 'cap', data: profile(40 + i, 100 + i) } }); }
  return (await call('GET', { query: { code: 'cap', backups: 1 } })).out.backups.length === 14;
})());
console.log(fails ? `\n${fails} FAILURE(S)` : '\nall API tests passed');
process.exit(fails ? 1 : 0);
