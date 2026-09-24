// Tests for .github/scripts/vercel-deploy.mjs against a stand-in Vercel API,
// run inside a throwaway git repository. Run with: node test/vercel-deploy.mjs
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../.github/scripts/vercel-deploy.mjs', import.meta.url));

// a tiny site: two site files, plus a test and a workflow that must NOT ship
const repo = mkdtempSync(join(tmpdir(), 'vdeploy-'));
const git = (...a) => execFileSync('git', a, { cwd: repo });
git('init', '-q');
writeFileSync(join(repo, 'index.html'), '<h1>hi</h1>');
mkdirSync(join(repo, 'api')); writeFileSync(join(repo, 'api', 'progress.js'), 'export default () => {}');
mkdirSync(join(repo, 'test')); writeFileSync(join(repo, 'test', 'smoke.mjs'), 'x');
mkdirSync(join(repo, '.github')); writeFileSync(join(repo, '.github', 'ci.yml'), 'y');
git('add', '-A');
writeFileSync(join(repo, 'build-info.json'), '{"sha":"abc"}'); // untracked, written by CI

// stand-in API; behaviour switched per scenario
let mode = 'ok';
const uploads = new Map();
let created = null, polls = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.headers.authorization !== 'Bearer tok') return send(403, { error: { code: 'forbidden' } });
    if (req.method === 'GET' && u.pathname === '/v9/projects/edu4dave') {
      return mode === 'noproject' ? send(404, { error: { code: 'not_found' } })
        : send(200, { id: 'prj_1', name: 'edu4dave', accountId: 'team_hobby' });
    }
    if (req.method === 'POST' && u.pathname === '/v2/files') {
      if (mode === 'readonly') return send(403, { error: { code: 'forbidden' } });
      const digest = createHash('sha1').update(body).digest('hex');
      if (digest !== req.headers['x-vercel-digest']) return send(400, { error: { code: 'digest_mismatch' } });
      if (u.searchParams.get('teamId') !== 'team_hobby') return send(400, { error: { code: 'missing_team' } });
      uploads.set(digest, body.length);
      return send(200, {});
    }
    if (req.method === 'POST' && u.pathname === '/v13/deployments') {
      created = { query: Object.fromEntries(u.searchParams), body: JSON.parse(body.toString()) };
      const missing = created.body.files.filter(f => !uploads.has(f.sha));
      if (missing.length) return send(400, { error: { code: 'missing_files' } });
      return send(200, { id: 'dpl_1', url: 'edu4dave-abc.vercel.app', readyState: 'QUEUED' });
    }
    if (req.method === 'GET' && u.pathname === '/v13/deployments/dpl_1') {
      polls++;
      if (mode === 'builderror') return send(200, { readyState: 'ERROR', errorMessage: 'Build failed' });
      return send(200, { readyState: polls < 3 ? 'BUILDING' : 'READY' });
    }
    send(404, {});
  });
});
await new Promise(r => server.listen(0, r));
const API = `http://localhost:${server.address().port}`;
const run = (env) => new Promise(resolve => {
  execFile(process.execPath, [script], {
    cwd: repo,
    env: { PATH: process.env.PATH, VERCEL_API: API, VERCEL_POLL_MS: '10', GITHUB_SHA: 'abc123', GITHUB_REF_NAME: 'main', ...env },
  }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout.trim(), err: stderr.trim() }));
});
let fails = 0;
const check = (n, ok, x = '') => { console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${n}${x ? ' — ' + x : ''}`); if (!ok) fails++; };

let r = await run({ VERCEL_TOKEN: 'tok' });
check('deploys and waits until READY', r.code === 0 && /Deployed dpl_1 to production/.test(r.out), r.out || r.err);
const shipped = created.body.files.map(f => f.file).sort();
check('ships the site files and the build stamp', JSON.stringify(shipped) === JSON.stringify(['api/progress.js', 'build-info.json', 'index.html']), shipped.join(','));
check('never ships tests or CI config', !shipped.some(f => f.startsWith('test/') || f.startsWith('.github/')));
check('production target, right project, team scope, commit recorded',
  created.body.target === 'production' && created.body.project === 'prj_1' &&
  created.query.teamId === 'team_hobby' && created.body.meta.githubCommitSha === 'abc123');
check('every referenced file was uploaded with a matching digest', created.body.files.every(f => uploads.get(f.sha) === f.size));

mode = 'builderror'; polls = 0;
r = await run({ VERCEL_TOKEN: 'tok' });
check('a failed Vercel build fails the job with its message', r.code !== 0 && /ended ERROR: Build failed/.test(r.err), r.err.split('\n').pop());
mode = 'readonly';
r = await run({ VERCEL_TOKEN: 'tok' });
check('read-only token → says it lacks deploy permission', r.code !== 0 && /permission to deploy/.test(r.err), r.err.split('\n').pop());
mode = 'noproject';
r = await run({ VERCEL_TOKEN: 'tok' });
check('unknown project → clear error', r.code !== 0 && /not found/.test(r.err));
mode = 'ok';
r = await run({ VERCEL_TOKEN: 'wrong' });
check('rejected token → clear error', r.code !== 0 && /rejected VERCEL_TOKEN/.test(r.err));
r = await run({});
check('no token → says nothing was deployed', r.code !== 0 && /NOT deployed/.test(r.err));
check('token never printed', !(r.out + r.err).includes('tok'));

server.close();
rmSync(repo, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILURE(S)` : '\nall vercel-deploy tests passed');
process.exit(fails ? 1 : 0);
