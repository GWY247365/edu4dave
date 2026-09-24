// Resolves the Vercel project and owner ids for the deploy job from just an
// access token, so nobody has to dig the "org id" out of the dashboard.
//
// Inputs (env):
//   VERCEL_TOKEN        required
//   VERCEL_PROJECT      optional: project id OR name (default: edu4dave)
//   VERCEL_ORG          optional: owner id; when set it is used as-is
// Output (stdout, meant for >> "$GITHUB_ENV"):
//   VERCEL_ORG_ID=…
//   VERCEL_PROJECT_ID=…
//
// The token only sees its owner's projects, so looking the project up by
// name cannot land on somebody else's. Personal projects resolve directly;
// team-owned ones are found by trying each team the token can see.
const token = process.env.VERCEL_TOKEN;
const project = (process.env.VERCEL_PROJECT || '').trim() || 'edu4dave';
const presetOrg = (process.env.VERCEL_ORG || '').trim();
const API = process.env.VERCEL_API || 'https://api.vercel.com';

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}
if (!token) fail('Tests passed but this commit was NOT deployed — missing repository secret VERCEL_TOKEN');

async function get(path) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  let body = {};
  try { body = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, body };
}

const idOrName = encodeURIComponent(project);
let r = await get(`/v9/projects/${idOrName}${presetOrg ? `?teamId=${encodeURIComponent(presetOrg)}` : ''}`);
if (!r.ok && !presetOrg) {
  const teams = await get('/v2/teams');
  for (const t of (teams.body && teams.body.teams) || []) {
    const tr = await get(`/v9/projects/${idOrName}?teamId=${encodeURIComponent(t.id)}`);
    if (tr.ok) { r = { ...tr, via: `team ${t.id}` }; break; }
  }
}
if (r.status === 401 || r.status === 403) fail(`Vercel rejected VERCEL_TOKEN (HTTP ${r.status}) — create a new token and update the secret`);
if (!r.ok) fail(`Vercel project "${project}" not found for this token (HTTP ${r.status}) — set VERCEL_PROJECT_ID to the project's id or name`);
const org = presetOrg || r.body.accountId;
if (!r.body.id || !org) fail('Vercel returned a project without an id or owner; cannot deploy');

// Probe the same two lookups the Vercel CLI makes when linking with these
// ids, so a failure names which one broke (stderr only: never the token).
const probes = [
  ['owner', org.startsWith('team_') ? `/v2/teams/${org}` : '/v2/user'],
  ['project', `/v9/projects/${r.body.id}${org.startsWith('team_') ? `?teamId=${org}` : ''}`],
];
for (const [label, path] of probes) {
  const p = await get(path);
  const msg = (p.body && p.body.error && (p.body.error.code || p.body.error.message)) || '';
  console.error(`probe ${label}: GET ${path.replace(/\?.*/, '')} -> HTTP ${p.status}${msg ? ' ' + msg : ''}`);
}
console.error(`resolved via ${r.via || 'direct lookup'}: owner ${org}, project ${r.body.id} (${r.body.name || '?'})`);

console.log(`VERCEL_ORG_ID=${org}`);
console.log(`VERCEL_PROJECT_ID=${r.body.id}`);
