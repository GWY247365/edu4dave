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
// The owner id must be one the Vercel CLI can actually open, and that is
// not always the project's accountId: a token can read a project while
// being refused the team object that owns it (403 team_unauthorized), and
// the CLI gives up if it cannot read the owner. So each candidate owner —
// the token's own user scope, the project's accountId, and every team the
// token can see — is checked with the same two lookups the CLI makes, and
// the first that passes both wins. The token only sees its owner's
// projects, so a lookup by name cannot land on anyone else's.
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
const why = (r) => {
  const e = r.body && r.body.error;
  return `HTTP ${r.status}${e && (e.code || e.message) ? ' ' + (e.code || e.message) : ''}`;
};
const q = (team) => (team ? `?teamId=${encodeURIComponent(team)}` : '');
const idOrName = encodeURIComponent(project);

// Candidate owners, most specific first.
const candidates = [];
if (presetOrg) candidates.push({ org: presetOrg, team: presetOrg.startsWith('team_') ? presetOrg : null, via: 'VERCEL_ORG_ID secret' });
const me = await get('/v2/user');
if (me.status === 401 || me.status === 403) {
  // Might be a team-only token; the team candidates below still get a try.
  console.error(`probe user scope: ${why(me)}`);
}
const userId = me.ok && me.body && me.body.user && (me.body.user.id || me.body.user.uid);
if (userId) candidates.push({ org: userId, team: null, via: 'personal scope' });
const teams = await get('/v2/teams');
for (const t of (teams.ok && teams.body && teams.body.teams) || []) candidates.push({ org: t.id, team: t.id, via: `team ${t.slug || t.id}` });

const tried = [];
let found = null, sawProject = null;
for (const c of candidates) {
  const p = await get(`/v9/projects/${idOrName}${q(c.team)}`);
  if (!p.ok) { tried.push(`${c.via}: project ${why(p)}`); continue; }
  sawProject = p.body;
  // Candidate owners from the project record itself (its accountId).
  if (p.body.accountId && !candidates.some(x => x.org === p.body.accountId)) {
    candidates.push({ org: p.body.accountId, team: p.body.accountId.startsWith('team_') ? p.body.accountId : null, via: 'project accountId' });
  }
  const owner = c.team ? await get(`/v2/teams/${encodeURIComponent(c.team)}`) : me;
  if (!owner.ok) { tried.push(`${c.via}: project ok, owner ${why(owner)}`); continue; }
  found = { org: c.org, id: p.body.id, name: p.body.name, via: c.via };
  break;
}

if (!found) {
  for (const t of tried) console.error(`  tried ${t}`);
  if (me.status === 401 || (me.status === 403 && !tried.length)) {
    fail(`Vercel rejected VERCEL_TOKEN (${why(me)}) — create a new token and update the secret`);
  }
  if (!sawProject) fail(`Vercel project "${project}" not found for this token — set VERCEL_PROJECT_ID to the project's id or name`);
  fail('The token can read the project but not any account that owns it, so the Vercel CLI cannot link it — recreate the token with its scope set to the account that owns the project');
}
console.error(`resolved via ${found.via}: owner ${found.org}, project ${found.id} (${found.name || '?'})`);
console.log(`VERCEL_ORG_ID=${found.org}`);
console.log(`VERCEL_PROJECT_ID=${found.id}`);
