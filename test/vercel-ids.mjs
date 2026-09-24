// Tests for .github/scripts/vercel-ids.mjs against a stand-in Vercel API.
// Run with: node test/vercel-ids.mjs
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../.github/scripts/vercel-ids.mjs', import.meta.url));
const GOOD = 'tok-good';
// personal project "edu4dave" + a team project "teamproj"
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const auth = req.headers.authorization;
  const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (auth !== `Bearer ${GOOD}`) return send(403, { error: { message: 'forbidden' } });
  if (u.pathname === '/v2/teams') return send(200, { teams: [{ id: 'team_other' }, { id: 'team_fam' }] });
  const m = u.pathname.match(/^\/v9\/projects\/(.+)$/);
  if (!m) return send(404, {});
  const key = decodeURIComponent(m[1]);
  const team = u.searchParams.get('teamId');
  if (!team && (key === 'edu4dave' || key === 'prj_personal')) return send(200, { id: 'prj_personal', accountId: 'user_123' });
  if (team === 'team_fam' && key === 'teamproj') return send(200, { id: 'prj_team', accountId: 'team_fam' });
  return send(404, { error: { message: 'not found' } });
});
await new Promise(r => server.listen(0, r));
const API = `http://localhost:${server.address().port}`;

const run = (env) => new Promise(resolve => {
  execFile(process.execPath, [script], { env: { PATH: process.env.PATH, VERCEL_API: API, ...env } },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout.trim(), err: stderr.trim() }));
});
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!ok) fails++; };

let r = await run({ VERCEL_TOKEN: GOOD });
check('token only → personal project found by default name, owner derived',
  r.code === 0 && r.out === 'VERCEL_ORG_ID=user_123\nVERCEL_PROJECT_ID=prj_personal', r.out || r.err);
r = await run({ VERCEL_TOKEN: GOOD, VERCEL_PROJECT: 'prj_personal' });
check('explicit project id works', r.code === 0 && r.out.includes('VERCEL_PROJECT_ID=prj_personal'));
r = await run({ VERCEL_TOKEN: GOOD, VERCEL_PROJECT: 'teamproj' });
check('team-owned project found by trying the token\'s teams',
  r.code === 0 && r.out === 'VERCEL_ORG_ID=team_fam\nVERCEL_PROJECT_ID=prj_team', r.out || r.err);
r = await run({ VERCEL_TOKEN: GOOD, VERCEL_PROJECT: 'teamproj', VERCEL_ORG: 'team_fam' });
check('explicit org id is used as-is', r.code === 0 && r.out.startsWith('VERCEL_ORG_ID=team_fam'));
r = await run({ VERCEL_TOKEN: 'tok-bad' });
check('bad token → clear error, non-zero exit', r.code !== 0 && /rejected VERCEL_TOKEN/.test(r.err), r.err);
r = await run({ VERCEL_TOKEN: GOOD, VERCEL_PROJECT: 'nope' });
check('unknown project → clear error', r.code !== 0 && /not found/.test(r.err), r.err);
r = await run({});
check('no token → says nothing was deployed', r.code !== 0 && /NOT deployed/.test(r.err), r.err);
check('token never printed', ![GOOD].some(t => (r.out + r.err).includes(t)));

server.close();
console.log(fails ? `\n${fails} FAILURE(S)` : '\nall vercel-ids tests passed');
process.exit(fails ? 1 : 0);
