// Tests for .github/scripts/vercel-ids.mjs against a stand-in Vercel API.
// Run with: node test/vercel-ids.mjs
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../.github/scripts/vercel-ids.mjs', import.meta.url));

// Accounts modelled on what production returned:
//   tok-hobby: personal user user_123. Its project "edu4dave" is readable in
//              personal scope AND with ?teamId=team_hobby, but reading the
//              team object team_hobby is refused (403 team_unauthorized) —
//              exactly what broke the CLI on the first real deploy.
//   tok-team:  member of team_fam, which owns "teamproj"; team readable.
//   tok-orphan: can read the project, but neither its user nor team object.
const TOKENS = {
  'tok-hobby': { user: 'user_123', teams: [{ id: 'team_hobby', readable: false }] },
  'tok-team': { user: 'user_456', teams: [{ id: 'team_other', readable: true }, { id: 'team_fam', readable: true }] },
  'tok-orphan': { user: null, teams: [{ id: 'team_x', readable: false }] },
};
const PROJECTS = [
  { id: 'prj_personal', name: 'edu4dave', accountId: 'team_hobby', personal: 'tok-hobby', teams: ['team_hobby'] },
  { id: 'prj_team', name: 'teamproj', accountId: 'team_fam', personal: null, teams: ['team_fam'] },
  { id: 'prj_orphan', name: 'orphan', accountId: 'team_x', personal: 'tok-orphan', teams: ['team_x'] },
];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  const acct = TOKENS[tok];
  const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (!acct) return send(403, { error: { code: 'forbidden' } });
  if (u.pathname === '/v2/user') return acct.user ? send(200, { user: { id: acct.user } }) : send(403, { error: { code: 'forbidden' } });
  if (u.pathname === '/v2/teams') return send(200, { teams: acct.teams.map(t => ({ id: t.id })) });
  let m = u.pathname.match(/^\/v2\/teams\/(.+)$/);
  if (m) {
    const t = acct.teams.find(x => x.id === decodeURIComponent(m[1]));
    return t && t.readable ? send(200, { id: t.id }) : send(403, { error: { code: 'team_unauthorized' } });
  }
  m = u.pathname.match(/^\/v9\/projects\/(.+)$/);
  if (m) {
    const key = decodeURIComponent(m[1]);
    const team = u.searchParams.get('teamId');
    const p = PROJECTS.find(x => x.id === key || x.name === key);
    const visible = p && (team ? p.teams.includes(team) && acct.teams.some(t => t.id === team) : p.personal === tok);
    return visible ? send(200, { id: p.id, name: p.name, accountId: p.accountId }) : send(404, { error: { code: 'not_found' } });
  }
  send(404, {});
});
await new Promise(r => server.listen(0, r));
const API = `http://localhost:${server.address().port}`;

const run = (env) => new Promise(resolve => {
  execFile(process.execPath, [script], { env: { PATH: process.env.PATH, VERCEL_API: API, ...env } },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout.trim(), err: stderr.trim() }));
});
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!ok) fails++; };

let r = await run({ VERCEL_TOKEN: 'tok-hobby' });
check('production case: team object refused → personal user id used, CLI can link',
  r.code === 0 && r.out === 'VERCEL_ORG_ID=user_123\nVERCEL_PROJECT_ID=prj_personal', r.out || r.err);
r = await run({ VERCEL_TOKEN: 'tok-team', VERCEL_PROJECT: 'teamproj' });
check('team-owned project with a readable team → team id',
  r.code === 0 && r.out === 'VERCEL_ORG_ID=team_fam\nVERCEL_PROJECT_ID=prj_team', r.out || r.err);
r = await run({ VERCEL_TOKEN: 'tok-hobby', VERCEL_PROJECT: 'prj_personal' });
check('explicit project id works', r.code === 0 && r.out.endsWith('VERCEL_PROJECT_ID=prj_personal'));
r = await run({ VERCEL_TOKEN: 'tok-team', VERCEL_PROJECT: 'teamproj', VERCEL_ORG: 'team_fam' });
check('explicit org id is honoured', r.code === 0 && r.out.startsWith('VERCEL_ORG_ID=team_fam'));
r = await run({ VERCEL_TOKEN: 'tok-orphan', VERCEL_PROJECT: 'orphan' });
check('project readable but no owner readable → explains the token scope', r.code !== 0 && /scope/.test(r.err), r.err.split('\n').pop());
r = await run({ VERCEL_TOKEN: 'tok-bad' });
check('bad token → clear error', r.code !== 0 && /rejected VERCEL_TOKEN/.test(r.err), r.err.split('\n').pop());
r = await run({ VERCEL_TOKEN: 'tok-hobby', VERCEL_PROJECT: 'nope' });
check('unknown project → clear error', r.code !== 0 && /not found/.test(r.err), r.err.split('\n').pop());
r = await run({});
check('no token → says nothing was deployed', r.code !== 0 && /NOT deployed/.test(r.err));
check('token never printed', !(r.out + r.err).includes('tok-'));

server.close();
console.log(fails ? `\n${fails} FAILURE(S)` : '\nall vercel-ids tests passed');
process.exit(fails ? 1 : 0);
