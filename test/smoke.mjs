// Browser smoke tests for Math Quiz. Run with: npm test
// Requires playwright (npm i -D playwright) and a Chromium; set CHROMIUM_PATH
// to use a system browser (falls back to Playwright's own download).
//
// These exist because DOM-less harnesses miss real bugs: the "dead Check
// answers on fraction quizzes" bug (v41) only reproduced in a real browser.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

let cloudVersion = 1;
let shipped = false;
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/progress') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(req.method === 'GET'
      ? JSON.stringify({ data: { hist: [], marker: cloudVersion } })
      : '{"ok":true}');
  }
  if (u.pathname === '/__bump') { cloudVersion++; res.writeHead(200); return res.end(); }
  // Simulates a release landing: from now on sw.js and the page are served
  // one version higher (in memory — nothing on disk changes).
  if (u.pathname === '/__ship') { shipped = true; res.writeHead(200); return res.end(); }
  try {
    const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    let body = await readFile(join(root, path));
    if (shipped && (path === '/sw.js' || path === '/index.html')) {
      body = Buffer.from(body.toString('utf8')
        .replace(/mathquiz-v(\d+)/, (m, n) => `mathquiz-v${Number(n) + 1}`)
        .replace(/const APP_VERSION = 'v(\d+)'/, (m, n) => `const APP_VERSION = 'v${Number(n) + 1}'`));
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise(r => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

async function startIfReady() {
  const btn = await page.$('.ready-start');
  if (btn) { await btn.click(); await page.waitForTimeout(250); }
}
async function fillAll(value) {
  // Re-query per element: a background render (e.g. the SW update chip on
  // first install) can rebuild the DOM and detach previously-grabbed handles.
  const n = (await page.$$('.ansbox')).length;
  for (let i = 0; i < n; i++) {
    const b = (await page.$$('.ansbox'))[i];
    if (!b || await b.evaluate(e => e.readOnly)) continue;
    await b.fill(value);
  }
  const m = (await page.$$('.fcmp-btn:not([disabled])')).length;
  for (let i = 0; i < m; i += 3) {
    const b = (await page.$$('.fcmp-btn:not([disabled])'))[0];
    if (b) await b.click();
  }
}

console.log('1. plain mixed quiz grades (via ready screen)');
await page.goto(base);
await page.waitForSelector('.ready-start');
check('boot shows ready screen, no questions, no clock', (await page.$$('.qcard')).length === 0
  && (await page.$eval('#timer', e => e.textContent)) === '');
// Let the first-install service worker take control (it re-renders once).
// Waiting on the real condition, not a fixed sleep, keeps slow CI runners green.
await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
await page.waitForTimeout(300);
await startIfReady();
await page.waitForSelector('.qcard');
await fillAll('7');
await page.click('button:has-text("Check answers")');
await page.waitForTimeout(400);
check('submitted', await page.evaluate(() => state.submitted));

console.log('2. fraction practice quiz grades (v41 regression)');
await page.evaluate(() => startFractionPractice());
await page.waitForTimeout(300);
check('fraction inputs present', (await page.$$('.frac-in')).length > 0);
await fillAll('3');
await page.click('button:has-text("Check answers")');
await page.waitForTimeout(400);
check('submitted', await page.evaluate(() => state.submitted));

console.log('3. immediate corrective feedback (practice mode)');
await page.evaluate(() => { localStorage.removeItem('mathquiz.session.v1'); });
await page.goto(base);
await page.waitForSelector('.ready-start, .qcard');
await page.evaluate(() => startFocus());
await page.waitForTimeout(300);
check('immediate flag on', await page.evaluate(() => state.immediate));
const ans0 = await page.evaluate(() => state.quiz[0].ans);
const first = (await page.$$('.ansbox'))[0];
await first.fill(String(Number(ans0) + 3));
await first.press('Enter');
await page.waitForTimeout(150);
check('wrong → fixpill shown', !!(await page.$('.fixpill')));
await first.fill(String(ans0));
await page.waitForTimeout(150);
check('overcorrection locks card', !!(await page.$('.qcard.imm-fixed')));
check('original wrong answer kept for grading',
  await page.evaluate(() => String(state.quiz[0].given) !== String(state.quiz[0].ans)));

console.log('4. session survives refresh');
await page.evaluate(() => { localStorage.removeItem('mathquiz.session.v1'); startNew(); });
await page.waitForTimeout(200);
const box = (await page.$$('.ansbox'))[0];
await box.fill('42');
await page.reload();
await page.waitForSelector('.qcard');
check('typed answer restored (resumes past ready screen)', (await page.$$eval('.ansbox', els => els.filter(e => e.value === '42').length)) === 1);
check('resumed quiz time is sane (not wall-clock overtime)', await page.evaluate(() => state.remaining > 8 * 60 || state.remaining === 600));

console.log('5. reroll fishing is closed: unanswered questions carry over');
await page.evaluate(() => { localStorage.removeItem('mathquiz.session.v1'); startNew(); });
await page.waitForTimeout(200);
const before = await page.evaluate(() => state.quiz
  .map(q => `${q.type}:${Math.min(q.a || 0, q.b || 0)}x${Math.max(q.a || 0, q.b || 0)}`));
// answer ONE adaptive question, leave the rest blank, then reroll 3 times
await page.evaluate(() => {
  const q = state.quiz.find(x => x.type !== 'add' && x.type !== 'sub');
  q.given = '1';
});
const answeredSig = await page.evaluate(() => {
  const q = state.quiz.find(x => x.given === '1');
  return `${q.type}:${Math.min(q.a || 0, q.b || 0)}x${Math.max(q.a || 0, q.b || 0)}`;
});
for (let r = 0; r < 3; r++) { await page.evaluate(() => startNew()); await page.waitForTimeout(100); }
const after = await page.evaluate(() => state.quiz
  .map(q => `${q.type}:${Math.min(q.a || 0, q.b || 0)}x${Math.max(q.a || 0, q.b || 0)}`));
const unansweredBefore = before.filter(s2 => s2 !== answeredSig);
const survived = unansweredBefore.filter(s2 => after.includes(s2)).length;
check('ALL unanswered questions (incl add/sub) survive 3 rerolls', survived === unansweredBefore.length,
  `${survived}/${unansweredBefore.length} carried`);
// the refresh path: reload to ready, start again — same full set
await page.reload();
await page.waitForSelector('.ready-start');
await page.click('.ready-start');
await page.waitForSelector('.qcard');
const after2 = await page.evaluate(() => state.quiz
  .map(q => `${q.type}:${Math.min(q.a || 0, q.b || 0)}x${Math.max(q.a || 0, q.b || 0)}`));
const survived2 = after.filter(s2 => after2.includes(s2)).length;
check('refresh → ready → start keeps the full set', survived2 === after.length, `${survived2}/${after.length}`);
const qlen = await page.evaluate(() => state.quiz.length);
check('quiz stays at 10 questions', qlen === 10, 'len=' + qlen);

console.log('6. daily session flow: warm-up → quiz → done, no choices needed');
await page.evaluate(() => { localStorage.clear(); });
await page.goto(base);
await page.waitForSelector('.ready-start');
check('fresh day shows ready screen first', true);
await startIfReady();
await page.waitForSelector('.qcard');
const boot = await page.evaluate(() => ({ step: state.dailyStep, imm: state.immediate, len: state.quiz.length }));
check('start launches warm-up (immediate mode)', boot.step === 'warmup' && boot.imm === true, JSON.stringify(boot));
check('warm-up is compact (5-6 questions)', boot.len >= 5 && boot.len <= 6, 'len=' + boot.len);
check('strip highlights warm-up', !!(await page.$('.day-chip.active')));
await fillAll('7');
await page.click('button:has-text("Check answers")');
await page.waitForTimeout(400);
const afterWarm = await page.evaluate(() => Stats.getDaily());
check('warm-up marked done', afterWarm.warmup === true && afterWarm.quiz === false);
check("CTA offers today's quiz", !!(await page.$(`button:has-text("Today's quiz")`)));
await page.click(`button:has-text("Today's quiz")`);
await page.waitForTimeout(300);
const step2 = await page.evaluate(() => ({ step: state.dailyStep, imm: state.immediate, len: state.quiz.length }));
check('second step is the batch mixed quiz', step2.step === 'quiz' && step2.imm === false && step2.len === 10, JSON.stringify(step2));
await fillAll('7');
await page.click('button:has-text("Check answers")');
await page.waitForTimeout(400);
const doneState = await page.evaluate(() => Stats.getDaily());
check('daily session complete', doneState.warmup === true && doneState.quiz === true);
check('celebration shown', !!(await page.$('.day-done')));
await page.evaluate(() => { state.showMine = true; render(); });
await page.waitForTimeout(150);
const mineBtns = await page.$$eval('.mine-modal .mine-go', els => els.map(e => e.textContent));
check('child page has exactly ONE practice button (no category menu)', mineBtns.length === 1, JSON.stringify(mineBtns));
await page.evaluate(() => { state.showMine = false; render(); });

console.log('7. word problems: answer keys, traps, schema diagnosis');
await page.evaluate(() => {
  // a profile fluent enough to unlock word problems
  for (let r = 0; r < 8; r++) for (let a = 2; a <= 12; a++) for (let b = a; b <= 12; b++) Stats.recordMul(a, b, true, 2000);
  Stats.checkUnlocks();
});
const wp = await page.evaluate(() => {
  let bad = 0;
  const kinds = {};
  for (let i = 0; i < 1500; i++) {
    const q = genWord();
    kinds[q.wkind] = 1;
    const [x, sym, y] = q.op.split(' ');
    const calc = sym === '+' ? +x + +y : sym === '−' ? +x - +y : sym === '×' ? +x * +y : +x / +y;
    if (calc !== q.ans || q.trap === q.ans || !Number.isInteger(q.ans) || q.ans <= 0) bad++;
  }
  const q = genWord('wcompare');
  return { bad, kinds: Object.keys(kinds).length, unlocked: Stats.isUnlocked('word'),
           trapDiag: diagnose(q, String(q.trap)).why, slipDiag: diagnose(q, String(q.ans + 1)).why };
});
check('word problems unlocked by fluency', wp.unlocked);
check('all four schemas generate', wp.kinds === 4, 'kinds=' + wp.kinds);
check('1500 generated problems are self-consistent', wp.bad === 0, wp.bad + ' bad');
check('keyword-matched answer diagnosed as wrong operation', /wrong operation/.test(wp.trapDiag));
check('right plan + bad arithmetic diagnosed as a slip', /plan was right/.test(wp.slipDiag));

console.log('8. sync reads live cloud data even with the service worker in control');
await page.goto(base);
await page.waitForSelector('.ready-start, .qcard');
await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 }).catch(() => {});
const swOn = await page.evaluate(() => !!navigator.serviceWorker.controller);
const reads = [];
for (let i = 0; i < 3; i++) {
  reads.push(await page.evaluate(() => cloudLoad('fam').then(d => d.marker)));
  await page.evaluate(() => fetch('/__bump'));
}
check('service worker is controlling the page', swOn);
check('each pull sees the latest cloud version (not the cached one)',
  reads[1] === reads[0] + 1 && reads[2] === reads[0] + 2, reads.join(' → '));

console.log('9. legacy answer times are capped on load');
const capped = await page.evaluate(() => {
  localStorage.setItem('mathquiz.stats.v1', JSON.stringify({
    facts: { '5x7': { right: 3, wrong: 0, stab: 3.6, recent: '1', avgT: 138507, last: Date.now(), lastSeen: Date.now() } },
    skills: { 'frac.fcmp': { right: 5, wrong: 1, stab: 5, recent: '11', avgT: 454102, last: Date.now(), lastSeen: Date.now() } },
    hist: [],
  }));
  localStorage.removeItem('mathquiz.session.v1');
  return true;
});
await page.reload();
await page.waitForSelector('.ready-start, .qcard');
const caps = await page.evaluate(() => [Stats.getFact(5, 7).avgT, Stats.getSkill('frac.fcmp').avgT]);
check('fact and skill averages capped at 30s', caps[0] === 30000 && caps[1] === 30000, caps.join(', '));

console.log('10. word problems can be read aloud');
const spoken = await page.evaluate(() => {
  window.__said = [];
  speechSynthesis.speak = u => window.__said.push(u.text);
  for (let r = 0; r < 8; r++) for (let a = 2; a <= 12; a++) for (let b = a; b <= 12; b++) Stats.recordMul(a, b, true, 2000);
  Stats.checkUnlocks(); state.showLesson = null; startWordPractice();
  return true;
});
await page.waitForSelector('.wsay');
const btns = (await page.$$('.wsay')).length, stories = (await page.$$('.wstory')).length;
check('every word problem has a read-aloud button', btns > 0 && btns === stories, `${btns}/${stories}`);
const storyText = await page.$eval('.wstory', e => e.textContent);
await page.click('.wsay');
check('button reads the story text', (await page.evaluate(() => window.__said[0])) === storyText);

console.log('11. word problems: practice-mode correction explains WHY before the retype');
const pills = await page.evaluate(() => {
  const q = genWord('wcompare');
  const card = document.createElement('div');
  const box = document.createElement('input');
  const row = document.createElement('div');
  row.appendChild(box); card.appendChild(row);
  const out = {};
  for (const [kind, val] of [['trap', q.trap], ['slip', q.ans + 1], ['unclear', q.ans + 997]]) {
    q.given = String(val); q._imm = undefined;
    out[kind] = buildFixPill(q).textContent;
    out[kind + 'Diag'] = diagnose(q, String(val)).why;
  }
  out.reason = wordReason(q); out.op = q.op; out.ans = String(q.ans);
  return out;
});
check('trap: names the wrong operation and gives the reason',
  /wrong operation/.test(pills.trap) && pills.trap.includes(pills.reason));
check('trap: shows the plan and the answer to type',
  pills.trap.includes(pills.op) && pills.trap.includes('Type ' + pills.ans));
check('slip: says the idea was right, still shows the plan',
  /Right idea/.test(pills.slip) && pills.slip.includes(pills.op));
check('unclear: makes no claim about the plan, gives the reason',
  !/Right idea|wrong operation/.test(pills.unclear) && pills.unclear.includes(pills.reason));
check('batch diagnosis no longer calls a wild guess "plan was right"',
  !/plan was right/.test(pills.unclearDiag) && /plan was right/.test(pills.slipDiag), pills.unclearDiag.slice(0, 60));

console.log('12. the difficulty controller reads only measured quizzes');
const ctl = await page.evaluate(() => {
  localStorage.clear(); Stats.reset();
  // Quizzes around 65%, interleaved with easy warm-ups and practice at 100%,
  // plus legacy untagged records. Distinct timestamps: history merges dedupe
  // by timestamp, and real sessions are minutes apart.
  const t0 = Date.now() - 3600000;
  const hist = [
    { n: 10, c: 6, t: 300, k: 'quiz' },
    { n: 5, c: 5, t: 60, k: 'warmup' },
    { n: 10, c: 7, t: 300, k: 'quiz' },
    { n: 10, c: 10, t: 200, k: 'practice' },
    { n: 10, c: 6, t: 300, k: 'quiz' },
    { n: 5, c: 5, t: 60, k: 'warmup' },
    { n: 5, c: 5, t: 50 },              // legacy compact warm-up: not a measurement
    { n: 10, c: 0, t: 3 },              // legacy blank submit: not a measurement
    { n: 10, c: 7, t: 300 },            // legacy full quiz: counts
  ].map((h, i) => ({ ...h, d: t0 + i * 60000 }));
  Stats.importMerge({ hist });
  const row = Stats.engineCheck().find(c => /Recent accuracy/.test(c.label));
  return { acc: Math.round(100 * Stats.recentAccuracy(5)), row: row && row.label };
});
check('controller accuracy uses quizzes only (6+7+6+7 of 40)', ctl.acc === 65, `acc=${ctl.acc}%`);
check('engine check reports the same number', ctl.row === 'Recent accuracy 65%', ctl.row);

const kinds = [];
await page.evaluate(() => { localStorage.clear(); });
await page.goto(base);
await page.waitForSelector('.ready-start');
await startIfReady();
await page.waitForSelector('.qcard');
await fillAll('7');
await page.click('button:has-text("Check answers")');
await page.waitForTimeout(300);
kinds.push(await page.evaluate(() => Stats.exportRaw().hist.slice(-1)[0].k));
await page.click(`button:has-text("Today's quiz")`);
await page.waitForTimeout(300);
await fillAll('7');
await page.click('button:has-text("Check answers")');
await page.waitForTimeout(300);
kinds.push(await page.evaluate(() => Stats.exportRaw().hist.slice(-1)[0].k));
await page.evaluate(() => startFocus());
await page.waitForTimeout(300);
await fillAll('7');
await page.click('button:has-text("Check answers")');
await page.waitForTimeout(300);
kinds.push(await page.evaluate(() => Stats.exportRaw().hist.slice(-1)[0].k));
check('real sessions are tagged warm-up, quiz, practice', kinds.join(',') === 'warmup,quiz,practice', kinds.join(','));

console.log('13. a release is announced when the app is resumed, not only on reload');
await page.goto(base);
await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
await page.waitForFunction(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return r && r.active && !r.installing && !r.waiting;
}, null, { timeout: 20000 });
await page.waitForTimeout(11000); // past the resume-check throttle window
check('no update prompt while nothing new has shipped', !(await page.$('.update-chip')));
await page.evaluate(() => fetch('/__ship'));
// the child brings the home-screen app back: resumed, not reloaded
await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
let announced = false;
for (let i = 0; i < 20 && !announced; i++) { await page.waitForTimeout(500); announced = !!(await page.$('.update-chip')); }
check('resuming the app surfaces a release shipped while it was open', announced);

check('no page errors across all scenarios', pageErrors.length === 0, pageErrors.join('; '));

await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall smoke tests passed');
process.exit(failures ? 1 : 0);
