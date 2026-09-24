// Deploys the checked-out commit to Vercel production through the REST API.
//
// Why not the Vercel CLI: the CLI resolves a user identity before it does
// anything (/v2/user), and the deploy token this project uses can read and
// deploy the project without being tied to a user (/v2/user → 404, the CLI
// fails with "User not found"). The REST flow below needs only the project.
//
// Steps: look the project up (by id or name, default edu4dave) → upload
// every file that makes up the site → create a production deployment that
// references them → poll until Vercel reports READY (or fails).
//
// Env: VERCEL_TOKEN (required), VERCEL_PROJECT (optional id or name),
//      GITHUB_SHA / GITHUB_REF_NAME (recorded on the deployment).
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const token = process.env.VERCEL_TOKEN;
const project = (process.env.VERCEL_PROJECT || '').trim() || 'edu4dave';
const API = process.env.VERCEL_API || 'https://api.vercel.com';
const POLL_MS = Number(process.env.VERCEL_POLL_MS || 5000);
const TIMEOUT_MS = Number(process.env.VERCEL_DEPLOY_TIMEOUT_MS || 8 * 60 * 1000);
// Not part of the site: tests, CI, and local tooling.
const EXCLUDE = [/^test\//, /^\.github\//, /^node_modules\//, /^\.vercel\//];

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}
if (!token) fail('Tests passed but this commit was NOT deployed — missing repository secret VERCEL_TOKEN');

async function call(method, path, { json, body, headers } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
    body: json ? JSON.stringify(json) : body,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}
const why = (r) => {
  const e = r.data && r.data.error;
  return `HTTP ${r.status}${e && (e.code || e.message) ? ' ' + (e.code || e.message) : ''}`;
};

// 1) the project, and the scope its API calls must carry
const p = await call('GET', `/v9/projects/${encodeURIComponent(project)}`);
if (p.status === 401 || p.status === 403) fail(`Vercel rejected VERCEL_TOKEN for project "${project}" (${why(p)}) — create a new token and update the secret`);
if (!p.ok) fail(`Vercel project "${project}" not found for this token (${why(p)}) — set VERCEL_PROJECT_ID to the project's id or name`);
const team = p.data.accountId && p.data.accountId.startsWith('team_') ? p.data.accountId : null;
const scope = (extra = '') => {
  const qs = [team ? `teamId=${encodeURIComponent(team)}` : '', extra].filter(Boolean).join('&');
  return qs ? `?${qs}` : '';
};
console.error(`project ${p.data.name} (${p.data.id})${team ? ` in ${team}` : ''}`);

// 2) the files: everything tracked in git that belongs to the site, plus
//    the build stamp the workflow writes just before this step
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const paths = tracked.filter(f => !EXCLUDE.some(rx => rx.test(f)));
if (existsSync('build-info.json') && !paths.includes('build-info.json')) paths.push('build-info.json');
const files = paths.map(file => {
  const buf = readFileSync(file);
  return { file, buf, sha: createHash('sha1').update(buf).digest('hex'), size: buf.length };
});
for (const f of files) {
  const up = await call('POST', `/v2/files${scope()}`, {
    body: f.buf,
    headers: { 'Content-Type': 'application/octet-stream', 'x-vercel-digest': f.sha, 'Content-Length': String(f.size) },
  });
  if (up.status === 401 || up.status === 403) fail(`VERCEL_TOKEN can read the project but may not upload deployment files (${why(up)}) — the token needs permission to deploy`);
  if (!up.ok) fail(`Uploading ${f.file} failed (${why(up)})`);
}
console.error(`uploaded ${files.length} files`);

// 3) the production deployment
const created = await call('POST', `/v13/deployments${scope('forceNew=1')}`, {
  json: {
    name: p.data.name,
    project: p.data.id,
    target: 'production',
    files: files.map(({ file, sha, size }) => ({ file, sha, size })),
    meta: {
      githubCommitSha: process.env.GITHUB_SHA || '',
      githubCommitRef: process.env.GITHUB_REF_NAME || '',
      deployedBy: 'github-actions',
    },
  },
});
if (created.status === 401 || created.status === 403) fail(`VERCEL_TOKEN may not create deployments (${why(created)}) — the token needs permission to deploy`);
if (!created.ok || !created.data.id) fail(`Creating the deployment failed (${why(created)})`);
const id = created.data.id;
console.error(`deployment ${id} created (${created.data.url || '?'})`);

// 4) wait for Vercel to finish building it
const started = Date.now();
let state = created.data.readyState || 'QUEUED';
while (!['READY', 'ERROR', 'CANCELED'].includes(state)) {
  if (Date.now() - started > TIMEOUT_MS) fail(`Deployment ${id} still ${state} after ${Math.round(TIMEOUT_MS / 60000)} min`);
  await new Promise(r => setTimeout(r, POLL_MS));
  const d = await call('GET', `/v13/deployments/${encodeURIComponent(id)}${scope()}`);
  if (!d.ok) { console.error(`poll: ${why(d)}`); continue; }
  if (d.data.readyState !== state) console.error(`state: ${d.data.readyState}`);
  state = d.data.readyState;
  if (state === 'ERROR' || state === 'CANCELED') {
    fail(`Deployment ${id} ended ${state}${d.data.errorMessage ? ': ' + d.data.errorMessage : ''}`);
  }
}
console.log(`Deployed ${id} to production: https://${created.data.url || ''}`);
