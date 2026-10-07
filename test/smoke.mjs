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
// Tap a number-line card at value v (0..max) through real pointer events,
// using the line's own geometry: 600 wide, 0 at x=30, max at x=570, axis y=64 of 112.
async function placeAt(card, v, max) {
  const svg = await card.$('.fpos-fig svg');
  // centred, so the fixed action bar at the bottom cannot be under the tap
  await svg.evaluate(e => e.scrollIntoView({ block: 'center' }));
  const b = await svg.boundingBox();
  await page.mouse.click(b.x + b.width * (30 + 540 * v / max) / 600, b.y + b.height * 64 / 112);
  await page.waitForTimeout(80);
}
// Answer a comparing or spot-the-mistake card through its buttons (the right
// answer unless pick says otherwise). Picking a sign re-renders, so the card
// is looked up again for each click.
async function answerChoice(i, q, pick = {}) {
  const card = async () => (await page.$$('.qcard'))[i];
  if (q.type === 'fcmp') {
    await (await (await card()).$(`.fcmp-btn:text-is("${pick.sign || q.ans}")`)).click();
    await page.waitForTimeout(60);
    if (q.ck) await (await (await card()).$(`.fcmp-why[data-key="${pick.why || q.ck}"]`)).click();
  } else await (await (await card()).$(`.ferr-opt[data-key="${pick.key || q.ans}"]`)).click();
  await page.waitForTimeout(60);
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

console.log('14. daily log: each day, each session, each question');
await page.evaluate(() => { localStorage.clear(); });
await page.goto(base);
await page.waitForSelector('.ready-start');
await startIfReady();                       // today's warm-up
await page.waitForSelector('.qcard');
await fillAll('7');
await page.click('button:has-text("Check answers")');
await page.waitForTimeout(300);
await page.click(`button:has-text("Today's quiz")`);
await page.waitForTimeout(300);
// answer the quiz with one deliberate miss so the log has something to show
await page.evaluate(() => {
  state.quiz.forEach((q, i) => {
    if (q.type === 'fnam') { q.givenNum = String(q.ansNum); q.givenDen = String(q.ansDen); }
    else q.given = i === 0 && q.type !== 'fcmp' ? String(Number(q.ans) + 1) : String(q.ans);
  });
  document.querySelectorAll('.ansbox').forEach(b => {
    const id = Number(b.dataset.id);
    if (Number.isInteger(id)) b.value = state.quiz[id].given;
  });
});
await page.click('button:has-text("Check answers")');
await page.waitForTimeout(300);
// an older day from before question-level detail existed
await page.evaluate(() => {
  const t = Date.now() - 3 * 86400000;
  Stats.importMerge({
    hist: [{ d: t, n: 10, c: 8, t: 400 }],
    errlog: [{ d: t + 1000, k: 'mul:7x8', x: [7, 8], g: '54', ans: '56' }],
  });
  state.showStats = true; render();
  document.querySelectorAll('details.stats-group').forEach(d => d.open = true);
  document.querySelectorAll('details.dlog-session').forEach(d => d.open = true);
});
const log = await page.evaluate(() => {
  const days = [...document.querySelectorAll('.dlog-day')];
  const first = days[0];
  return {
    days: days.length,
    todaySessions: first ? [...first.querySelectorAll('.dlog-kind')].map(e => e.textContent) : [],
    todayQuestions: first ? first.querySelectorAll('.dlog-q').length : 0,
    todayMisses: first ? first.querySelectorAll('.dlog-q.bad').length : 0,
    gap: (document.querySelector('.dlog-gap') || {}).textContent || '',
    oldMistakes: days[1] ? (days[1].querySelector('.dlog-errs') || {}).textContent || '' : '',
    stored: Stats.getHist().filter(h => Array.isArray(h.q)).map(h => h.q.length),
  };
});
check('today and an older day are listed', log.days === 2, `days=${log.days}`);
check("today's two sessions, in order", log.todaySessions.join(',') === '🎯 Warm-up,📝 Quiz', log.todaySessions.join(','));
check('every question of both sessions is listed', log.todayQuestions === log.stored.reduce((a, b) => a + b, 0) && log.todayQuestions >= 15, `${log.todayQuestions} rows`);
check('the deliberate miss is marked', log.todayMisses >= 1, `misses=${log.todayMisses}`);
check('days without practice are called out', /2 days without practice/.test(log.gap), log.gap);
check('an older day shows its mistakes from the error log', /7 × 8: 54 → 56/.test(log.oldMistakes), log.oldMistakes);

console.log('15. remainders & long division: generator, steps, diagnosis, unlock, real inputs');
await page.evaluate(() => { localStorage.clear(); });
await page.goto(base);
await page.waitForSelector('.ready-start, .qcard');
const ld = await page.evaluate(() => {
  const bad = [];
  let zeroInside = 0;
  for (let i = 0; i < 1500; i++) {
    const q = genLongDiv();
    if (q.a !== q.b * q.ans + q.rem || q.rem < 0 || q.rem >= q.b) bad.push(`${q.a}÷${q.b}=${q.ans}R${q.rem}`);
    if (q.ldk === 'rem' && q.rem === 0) bad.push('rem kind without remainder');
    if (q.ldk === 'long2' && (q.a > 99 || q.ans < 11)) bad.push(`long2 ${q.a}`);
    if (q.ldk === 'long3' && (q.a < 100 || q.a > 999)) bad.push(`long3 ${q.a}`);
    if (String(q.ans).slice(1).includes('0')) zeroInside++;
    const last = longDivSteps(q.a, q.b).slice(-1)[0];
    if (last !== `Answer: ${q.ans} R ${q.rem}`) bad.push(`steps ${q.a}÷${q.b}: ${last}`);
  }
  const mk = (a, b, ans, rem, ldk, gq, gr) => ({ type: 'ldiv', ldk, a, b, ans, rem, givenQ: gq, givenR: gr });
  const miss = [
    ldivMiss(mk(47, 6, 7, 5, 'rem', '6', '11')),
    ldivMiss(mk(47, 6, 7, 5, 'rem', '7', '')),
    ldivMiss(mk(47, 6, 7, 5, 'rem', '7', '4')),
    ldivMiss(mk(624, 6, 104, 0, 'long3', '14', '0')),
    ldivMiss(mk(156, 6, 26, 0, 'long2', '31', '0')),
    ldivMiss(mk(156, 6, 26, 0, 'long2', '', '')),
  ].join(',');
  const grade = [
    answerCorrect(mk(84, 4, 21, 0, 'long2', '21', '')),   // blank remainder means 0
    answerCorrect(mk(47, 6, 7, 5, 'rem', '7', '5')),
    !answerCorrect(mk(47, 6, 7, 5, 'rem', '7', '')),      // forgotten remainder is wrong
  ].every(Boolean);
  const zeroStep = longDivSteps(624, 6).some(l => /doesn't fit, so write 0/.test(l));
  // unlock: word problems first, then 40 solid division families
  localStorage.clear(); Stats.reset();
  for (let r = 0; r < 8; r++) for (let a = 2; a <= 12; a++) for (let b = a; b <= 12; b++) Stats.recordMul(a, b, true, 2000);
  Stats.checkUnlocks();
  const before = { word: Stats.isUnlocked('word'), longdiv: Stats.isUnlocked('longdiv'), next: (Stats.nextUnlock() || {}).name };
  let n = 0;
  for (let b = 2; b <= 12 && n < 40; b++) for (let c = b; c <= 12 && n < 40; c++) { for (let r = 0; r < 4; r++) Stats.recordDiv(b, c, true, 3000); n++; }
  const newly = Stats.checkUnlocks();
  const inQuiz = Array.from({ length: 20 }, () => newQuiz().filter(q => q.type === 'ldiv').length);
  return { bad: bad.slice(0, 3), badCount: bad.length, zeroInside, miss, grade, zeroStep, before, newly,
           solid: Stats.divMasteredCount(), inQuiz: Math.min(...inQuiz) };
});
check('1500 generated problems: a = b × q + r, r < b, ranges per kind, steps end in the answer', ld.badCount === 0, ld.bad.join('; '));
check('some quotients have a zero inside', ld.zeroInside > 0, `${ld.zeroInside}`);
check('the worked steps write the 0 when the divisor does not fit', ld.zeroStep);
check('grading needs both quotient and remainder; blank remainder means 0', ld.grade);
check('diagnosis classes: big remainder, no remainder, remainder slip, dropped zero, other, blank',
  ld.miss === 'bigrem,norem,remslip,zeroskip,other,blank', ld.miss);
check('locked until division is solid, and it is the next unlock after word problems',
  ld.before.word && !ld.before.longdiv && ld.before.next === 'Long division', JSON.stringify(ld.before));
check('unlocks at 40 solid division families', ld.newly === 'longdiv' && ld.solid >= 40, `newly=${ld.newly} solid=${ld.solid}`);
check('once unlocked, every daily quiz includes long division', ld.inQuiz >= 1, `min per quiz=${ld.inQuiz}`);

// the child types through the real inputs; the first answer drops the zero
await page.evaluate(() => {
  startLongDivPractice();
  state.quiz[0] = { type: 'ldiv', ldk: 'long3', a: 624, b: 6, ans: 104, rem: 0, label: 'Long division', isReview: false, id: 0, given: '' };
  render();
});
await page.waitForSelector('.ldiv-row');
const nq = await page.evaluate(() => state.quiz.length);
for (let i = 0; i < nq; i++) {
  const q = await page.evaluate(i => state.quiz[i], i);
  const card = (await page.$$('.qcard'))[i];
  if (q.type === 'ldiv') {
    const [qi, ri] = await card.$$('input');
    await qi.fill(i === 0 ? '14' : String(q.ans));
    await ri.fill(String(q.rem));
  } else {
    await (await card.$('input')).fill(String(q.ans));
  }
}
await page.click('button:has-text("Check answers")');
await page.waitForTimeout(400);
const ldRun = await page.evaluate(() => {
  const raw = Stats.exportRaw();
  const sk = raw.skills.longdiv || {};
  const firstCard = document.querySelector('.qcard');
  return {
    submitted: state.submitted,
    wrong: state.quiz.filter(q => !answerCorrect(q)).map(q => q.a).join(','),
    ldivCount: state.quiz.filter(q => q.type === 'ldiv').length,
    recorded: (sk.right || 0) + (sk.wrong || 0), right: sk.right || 0,
    err: raw.errlog.slice(-1)[0] || {},
    logRow: (raw.hist.slice(-1)[0].q || []).find(r => String(r[0]).startsWith('624')) || [],
    diagText: firstCard ? firstCard.textContent : '',
    teach: JSON.stringify(teachPayload(state.quiz[0])),
  };
});
check('long-division practice grades through the real inputs', ldRun.submitted && ldRun.wrong === '624', `wrong=${ldRun.wrong}`);
check('every long-division answer is recorded', ldRun.recorded === ldRun.ldivCount && ldRun.right === ldRun.ldivCount - 1,
  `${ldRun.right}/${ldRun.recorded} of ${ldRun.ldivCount}`);
check('the dropped zero is logged as such', ldRun.err.k === 'ldiv.long3' && ldRun.err.zskip === true && ldRun.err.g === '14 R 0', JSON.stringify(ldRun.err));
check('the card explains the missing zero and shows the steps',
  /zero is missing/.test(ldRun.diagText) && /write 0 in the answer/.test(ldRun.diagText));
check('the daily log shows the question with both answers', ldRun.logRow[1] === '14 R 0' && ldRun.logRow[2] === '104 R 0', JSON.stringify(ldRun.logRow));
check('"Teach me this" sends the whole problem', ldRun.teach === '{"type":"ldiv","a":624,"b":6,"q":104,"r":0}', ldRun.teach);
await page.evaluate(() => { state.showLesson = 'longdiv'; render(); });
await page.waitForTimeout(200);
check('the long-division lesson opens and offers practice',
  await page.evaluate(() => { const m = document.querySelector('.modal'); return !!m && /Try some/.test(m.textContent); }));
await page.evaluate(() => { state.showLesson = null; localStorage.clear(); });

console.log('16. two-step word problems: steps, tempting wrong answers, unlock, real inputs');
await page.evaluate(() => { localStorage.clear(); });
await page.goto(base);
await page.waitForSelector('.ready-start, .qcard');
const ms = await page.evaluate(() => {
  localStorage.clear(); Stats.reset();
  for (let r = 0; r < 8; r++) for (let a = 2; a <= 12; a++) for (let b = a; b <= 12; b++) Stats.recordMul(a, b, true, 2000);
  Stats.checkUnlocks();
  const kindsBefore = mKinds().length;                 // leftovers wait for long division
  const before = { word: Stats.isUnlocked('word'), multi: Stats.isUnlocked('multi') };
  for (const k of ['wjoin', 'wcompare']) for (let i = 0; i < 6; i++) { Stats.recordSkill('word', true, 9000); Stats.recordSkill('word.' + k, true, 9000); }
  const at2 = Stats.checkUnlocks();
  for (let i = 0; i < 6; i++) { Stats.recordSkill('word', true, 9000); Stats.recordSkill('word.wgroups', true, 9000); }
  const at3 = Stats.checkUnlocks();
  Stats.importMerge({ unlocked: { longdiv: true } });
  const ev = (x, o, y) => o === '+' ? x + y : o === '−' ? x - y : x * y;
  const bad = [], kinds = new Set();
  let wrongs = 0;
  for (let i = 0; i < 1500; i++) {
    const q = genMulti();
    kinds.add(q.wkind);
    if (/undefined|NaN/.test(q.text + q.steps.join() + q.plan)) bad.push('text: ' + q.text);
    let last = null;
    for (const st of q.steps) for (const m of st.matchAll(/(\d+) ([+−×]) (\d+) = (\d+)/g)) {
      if (ev(+m[1], m[2], +m[3]) !== +m[4]) bad.push('step: ' + st);
      last = +m[4];
    }
    if (q.wkind !== 'mrem' && last !== q.ans) bad.push(`last step ≠ answer: ${q.steps.join(' | ')}`);
    if (q.wkind === 'mrem') {
      const d = q.steps[0].match(/(\d+) ÷ (\d+) = (\d+) R (\d+)/);
      if (!d || +d[2] * +d[3] + +d[4] !== +d[1] || +d[4] === 0 || +d[4] >= +d[2]) bad.push('division: ' + q.steps[0]);
    }
    if (q.wrongs.some(w => w.v === q.ans) || new Set(q.wrongs.map(w => w.v)).size !== q.wrongs.length) bad.push('wrong answers overlap: ' + q.text);
    for (const w of q.wrongs) { wrongs++; if (diagnose(q, String(w.v)).why !== w.why) bad.push(`diagnosis ${q.wvar}/${w.cls}`); }
    if (!answerCorrect({ ...q, given: String(q.ans) })) bad.push('grading: ' + q.text);
  }
  const inQuiz = Math.min(...Array.from({ length: 30 }, () => newQuiz().filter(q => q.multi).length));
  return { kindsBefore, before, at2, at3, bad: bad.slice(0, 3), badCount: bad.length, kinds: [...kinds].sort().join(','), wrongs, inQuiz,
           next: (Stats.nextUnlock() || {}).name || null };
});
check('locked until 3 of the 4 one-step kinds are solid', ms.before.word && !ms.before.multi && ms.at2 !== 'multi' && ms.at3 === 'multi', JSON.stringify(ms));
check('leftover problems wait for long division', ms.kindsBefore === 3 && ms.kinds === 'mchange,mcompare,mgroups,mrem', `${ms.kindsBefore} → ${ms.kinds}`);
check('1500 problems: every step is true, the last step is the answer, divisions have a real remainder', ms.badCount === 0, ms.bad.join('; '));
check('every tempting wrong answer gets its own reason', ms.badCount === 0 && ms.wrongs > 2500, `${ms.wrongs} checked`);
check('once unlocked, every daily quiz has a two-step problem', ms.inQuiz >= 1, `min per quiz=${ms.inQuiz}`);

// the child answers through the real inputs and stops after step 1 on the first
const pinMulti = () => page.evaluate(() => {
  localStorage.removeItem('mathquiz.session.v1');
  startMultiPractice();
  const q = genMulti('mcompare');
  Object.assign(q, { wvar: 'cmp-more', ans: 72, op: '30 + (30 + 12)',
    text: 'Leo has 30 marbles. Mia has 12 more marbles than Leo. How many marbles do they have altogether?',
    steps: ['30 + 12 = 42 marbles for Mia', '30 + 42 = 72 marbles altogether'],
    plan: 'First find how many Mia has, then put both amounts together.',
    wrongs: [{ v: 42, cls: 'early', why: '42 is how many Mia has. The question asks for both of them together, so there is one more step.' }],
    scaffold: { kind: 'plan' }, isReview: false });
  state.quiz[0] = { ...q, id: 0, given: '' };
  render();
});
await pinMulti();
check('a learner sees the two steps named before answering', /Two steps: First find how many Mia has/.test(await page.$eval('.qcard .pretip', e => e.textContent)));
const firstBox = await (await page.$$('.qcard'))[0].$('input');
await firstBox.fill('42'); await firstBox.press('Enter');
await page.waitForTimeout(200);
const hint = await page.evaluate(() => ({ pill: document.querySelector('.fixpill').textContent, hint: !!document.querySelector('.fixpill.hintpill'),
                                          box: document.querySelector('.qcard input').value, imm: state.quiz[0]._imm }));
check('practice mode: a first miss names stopping early, but shows neither the steps nor the answer', hint.hint && hint.imm === 'retry' && hint.box === '' &&
  /one more step/.test(hint.pill) && /another go/.test(hint.pill) && !/Step 1|72/.test(hint.pill), JSON.stringify(hint));
await firstBox.press('Enter');
check('…an empty second try does nothing', await page.evaluate(() => state.quiz[0]._imm === 'retry' && !!document.querySelector('.fixpill.hintpill')));
await firstBox.fill('42'); await firstBox.press('Enter');
await page.waitForTimeout(200);
const fix = await page.$eval('.fixpill', e => e.textContent);
check('…a second miss shows both steps and the answer to type', /one more step/.test(fix) && /Step 1: 30 \+ 12 = 42/.test(fix) && /Step 2: 30 \+ 42 = 72/.test(fix) && /Type 72/.test(fix), fix.slice(0, 80));
await firstBox.fill('72');
await page.waitForTimeout(150);
check('…copying it locks the card; the first try is what gets graded', await page.evaluate(() =>
  state.quiz[0]._imm === 'fixed' && document.querySelector('.qcard').classList.contains('imm-fixed') && state.quiz[0].given === '42' && !answerCorrect(state.quiz[0])));
await pinMulti();
const box2 = await (await page.$$('.qcard'))[0].$('input');
await box2.fill('42'); await box2.press('Enter');
await page.waitForTimeout(150);
await box2.fill('72');
await page.waitForTimeout(150);
const hintOk = await page.evaluate(() => ({ imm: state.quiz[0]._imm, pill: !!document.querySelector('.qcard .fixpill') }));
await box2.press('Enter');
await page.waitForTimeout(150);
const hintOk2 = await page.evaluate(() => ({ imm: state.quiz[0]._imm, pill: !!document.querySelector('.qcard .fixpill'), cls: document.querySelector('.qcard').className,
                                             given: state.quiz[0].given, right: answerCorrect(state.quiz[0]) }));
const leak = await page.evaluate(() => {
  const says = (t, n) => new RegExp('(^|[^0-9])' + n + '(?![0-9])').test(t), bad = [];
  for (let i = 0; i < 1200; i++) {
    const r = i % 4, q = r === 0 ? genWord() : r === 1 ? genMulti() : r === 2 ? genGeo() : genMul2();
    const vals = r === 0 ? [q.trap, ...(q.extraVals || []), q.ans + 1, q.ans + 37] : [...q.wrongs.map(w => w.v), q.ans + 1, q.ans + 37];
    const shown = `${q.text || ''} ${q.desc || ''} ${q.type === 'mul2' ? q.a + ' ' + q.b : ''}`;   // a number in the problem itself gives nothing away
    for (const v of vals) { const t = buildHintPill({ ...q, given: String(v) }).textContent; if (says(t, q.ans) && !says(shown, q.ans)) bad.push(`${q.wkind || q.gk || q.mk}: ${t}`); }
  }
  return bad.slice(0, 3);
});
check('a first-miss hint never states the answer, across 1200 stories, two-step, area and 2-digit problems', !leak.length, leak.join(' | '));
check('…a right second try counts only after Enter, then locks with no answer shown; still graded on the first try',
  hintOk.imm === 'retry' && hintOk2.imm === 'fixed' && !hintOk2.pill && /imm-fixed/.test(hintOk2.cls) && hintOk2.given === '42' && !hintOk2.right,
  JSON.stringify([hintOk, hintOk2]));
await pinMulti();
await page.evaluate(() => { state.immediate = false; render(); });
const nMulti = await page.evaluate(() => state.quiz.length);
for (let i = 0; i < nMulti; i++) {
  const q = await page.evaluate(i => state.quiz[i], i);
  await (await (await page.$$('.qcard'))[i].$('input')).fill(i === 0 ? '42' : String(q.ans));
}
await page.click('button:has-text("Check answers")');
await page.waitForTimeout(400);
const msRun = await page.evaluate(() => {
  const raw = Stats.exportRaw(), sk = raw.skills.multi || {};
  return {
    wrong: state.quiz.filter(q => !answerCorrect(q)).length,
    multiCount: state.quiz.filter(q => q.multi).length,
    right: sk.right || 0, recorded: (sk.right || 0) + (sk.wrong || 0),
    err: raw.errlog.slice(-1)[0] || {},
    logRow: raw.hist.slice(-1)[0].q[0] || [],
    diag: document.querySelector('.qcard .diag').textContent,
    teach: teachPayload(state.quiz[0]),
  };
});
check('two-step practice grades through the real inputs', msRun.wrong === 1 && msRun.recorded === msRun.multiCount && msRun.right === msRun.multiCount - 1,
  `${msRun.right}/${msRun.recorded} of ${msRun.multiCount}`);
check('stopping early is logged as such', msRun.err.k === 'multi.mcompare' && msRun.err.early === true && msRun.err.g === '42', JSON.stringify(msRun.err));
check('the card names the mistake and shows both steps', /one more step/.test(msRun.diag) && /Step 2: 30 \+ 42 = 72/.test(msRun.diag));
check('the daily log shows the question and the story', msRun.logRow[0] === '🪜 Compare, then total' && msRun.logRow[1] === '42' && /Leo has 30/.test(msRun.logRow[4] || ''), JSON.stringify(msRun.logRow));
check('"Teach me this" sends the story and both steps', msRun.teach.steps && msRun.teach.steps.length === 2 && msRun.teach.ans === 72);
const redo = await page.evaluate(() => {
  const old = state.quiz[0];
  retryWrong();
  const q = state.quiz[0];
  return { n: state.quiz.length, multi: !!q.multi, kind: q.wkind, same: q.text === old.text, given: q.given, imm: q._imm };
});
check('"Retry missed" gives a fresh two-step problem of the same kind, not the one just answered', redo.n === 1 && redo.multi && redo.kind === 'mcompare' && !redo.same && redo.given === '' && redo.imm === undefined,
  JSON.stringify(redo));
const msPat = await page.evaluate(() => {
  Stats.recordError({ d: Date.now() + 5, k: 'multi.mcompare', g: '50', ans: '80', early: true });
  return Stats.errorPatterns().filter(p => p.key === 'multi.mcompare').map(p => p.kind + ': ' + p.label)[0] || '';
});
check('repeated early stops become a named pattern for the parent', /^misconception: .*stops after the first step/.test(msPat), msPat);
await page.evaluate(() => { state.showLesson = 'multi'; render(); });
await page.waitForTimeout(200);
check('the two-step lesson opens, with the leftovers section once long division is open',
  await page.evaluate(() => { const m = document.querySelector('.modal'); return !!m && /Try some/.test(m.textContent) && /the question decides/i.test(m.textContent); }));
await page.evaluate(() => { state.showLesson = null; localStorage.clear(); });

console.log('17. area & perimeter: figures, the area/perimeter mix-up, unlock, real inputs');
await page.evaluate(() => { localStorage.clear(); });
await page.goto(base);
await page.waitForSelector('.ready-start, .qcard');
const geo = await page.evaluate(() => {
  localStorage.clear(); Stats.reset();
  for (let r = 0; r < 8; r++) for (let a = 2; a <= 12; a++) for (let b = a; b <= 12 && (a - 2) * 11 + b < 60; b++) Stats.recordMul(a, b, true, 2000);
  const at = Stats.mulFluentCount();
  Stats.checkUnlocks();
  const unlockedAt = { fluent: at, geo: Stats.isUnlocked('geo') };
  const kinds0 = gKinds().join(',');
  for (const k of ['area', 'perim']) for (let i = 0; i < 6; i++) { Stats.recordSkill('geo', true, 9000); Stats.recordSkill('geo.' + k, true, 9000); }
  const kinds1 = gKinds().join(',');
  const bad = [];
  let wrongs = 0, mixListed = 0;
  for (let i = 0; i < 1500; i++) {
    const q = genGeo(), s = q.shape;
    const truth = q.gk === 'lshape' ? s.W * s.H - s.cw * s.ch : q.ask === 'area' ? s.w * s.h : q.ask === 'perim' ? 2 * (s.w + s.h) : (s.unknown === 'w' ? s.w : s.h);
    if (truth !== q.ans) bad.push(`${q.gk} ${JSON.stringify(s)} → ${q.ans}`);
    if (!q.steps.join(' ').includes(String(q.ans))) bad.push('steps miss the answer: ' + q.steps.join(' / '));
    if (/undefined|NaN/.test(q.desc + q.steps.join() + geoFigure(q, true).innerHTML)) bad.push('text/figure: ' + q.desc);
    if (q.wrongs.some(w => w.v === q.ans)) bad.push('a wrong answer equals the answer: ' + q.desc);
    if ((q.gk === 'area' || q.gk === 'perim') && q.wrongs.some(w => /perim|area/.test(w.cls))) mixListed++;
    for (const w of q.wrongs) { wrongs++; if (diagnose(q, String(w.v)).why !== w.why) bad.push(`diagnosis ${q.gk}/${w.cls}`); }
    if (!answerCorrect({ ...q, given: String(q.ans) })) bad.push('grading: ' + q.desc);
  }
  const basics = Array.from({ length: 200 }, () => genGeo(Math.random() < 0.5 ? 'area' : 'perim'));
  return { unlockedAt, kinds0, kinds1, bad: bad.slice(0, 3), badCount: bad.length, wrongs,
           mixAll: basics.every(q => q.wrongs.some(w => /perim|area/.test(w.cls))),
           inQuiz: Math.min(...Array.from({ length: 30 }, () => newQuiz().filter(q => q.type === 'geo').length)) };
});
check('unlocks at 45 fluent multiplication facts', geo.unlockedAt.geo && geo.unlockedAt.fluent >= 45, JSON.stringify(geo.unlockedAt));
check('L-shapes, missing sides and choosing the measure wait until area and perimeter are solid', geo.kinds0 === 'area,perim' && geo.kinds1 === 'area,perim,lshape,missing,which', `${geo.kinds0} → ${geo.kinds1}`);
check('1500 problems: answers match the figure, steps reach the answer, figures draw', geo.badCount === 0, geo.bad.join('; '));
check('every area problem lists its perimeter as a wrong answer, and the reverse', geo.mixAll);
check('every listed wrong answer is diagnosed with its own reason', geo.badCount === 0 && geo.wrongs > 3000, `${geo.wrongs} checked`);
check('once unlocked, every daily quiz has an area or perimeter problem', geo.inQuiz >= 1, `min per quiz=${geo.inQuiz}`);

// the child gives the area of a perimeter problem, through the real input
await page.evaluate(() => {
  localStorage.clear(); Stats.reset();       // count only this session's answers
  startGeoPractice(); state.immediate = false;
  const q = genGeo('perim');
  Object.assign(q, { shape: { w: 6, h: 4 }, unit: 'cm', ans: 20, desc: 'A rectangle is 6 cm long and 4 cm wide. What is its perimeter?',
    steps: ['Opposite sides are equal: 6 + 4 + 6 + 4 = 20 cm'],
    wrongs: [{ v: 24, cls: 'area', why: '24 is the area, the squares inside. Perimeter is the distance around: add all four sides.' }],
    scaffold: { kind: 'grid' }, isReview: false });
  state.quiz[0] = { ...q, id: 0, given: '' };
  render();
});
const geoCard = await page.evaluate(() => {
  const c = document.querySelector('.qcard');
  return { lines: c.querySelectorAll('.geo-grid').length, labels: [...c.querySelectorAll('.geo-lbl')].map(t => t.textContent).join(','),
           unit: (c.querySelector('.geo-unit') || {}).textContent };
});
check('the learner figure has its unit grid, side labels and the answer unit', geoCard.lines === 8 && geoCard.labels === '6 cm,4 cm' && geoCard.unit === 'cm', JSON.stringify(geoCard));
const nGeo = await page.evaluate(() => state.quiz.length);
for (let i = 0; i < nGeo; i++) {
  const q = await page.evaluate(i => state.quiz[i], i);
  await (await (await page.$$('.qcard'))[i].$('input')).fill(i === 0 ? '24' : String(q.ans));
}
await page.click('button:has-text("Check answers")');
await page.waitForTimeout(400);
const geoRun = await page.evaluate(() => {
  const raw = Stats.exportRaw(), sk = raw.skills.geo || {};
  return {
    wrong: state.quiz.filter(q => !answerCorrect(q)).length, geoCount: state.quiz.filter(q => q.type === 'geo').length,
    right: sk.right || 0, recorded: (sk.right || 0) + (sk.wrong || 0),
    err: raw.errlog.slice(-1)[0] || {}, logRow: raw.hist.slice(-1)[0].q[0] || [],
    diag: document.querySelector('.qcard .diag').textContent, teach: teachPayload(state.quiz[0]),
  };
});
check('area & perimeter practice grades through the real inputs', geoRun.wrong === 1 && geoRun.recorded === geoRun.geoCount && geoRun.right === geoRun.geoCount - 1,
  `${geoRun.right}/${geoRun.recorded} of ${geoRun.geoCount}`);
check('the mix-up is logged as such', geoRun.err.k === 'geo.perim' && geoRun.err.mix === true && geoRun.err.g === '24', JSON.stringify(geoRun.err));
check('the card names the mix-up and shows the working', /24 is the area/.test(geoRun.diag) && /6 \+ 4 \+ 6 \+ 4 = 20 cm/.test(geoRun.diag));
check('the daily log shows the shape and the problem', geoRun.logRow[0] === '📏 Perimeter: 6 × 4' && geoRun.logRow[1] === '24' && /6 cm long/.test(geoRun.logRow[4] || ''), JSON.stringify(geoRun.logRow));
check('"Teach me this" sends the problem in words, with the working', geoRun.teach.type === 'geo' && /6 cm long/.test(geoRun.teach.text) && geoRun.teach.steps.length === 1);
const geoPat = await page.evaluate(() => {
  Stats.recordError({ d: Date.now() + 5, k: 'geo.perim', g: '30', ans: '22', mix: true });
  return Stats.errorPatterns().filter(p => p.key === 'geo.perim').map(p => p.kind + ': ' + p.label)[0] || '';
});
check('repeated mix-ups become a named pattern for the parent', /^misconception: .*mixes up area and perimeter/.test(geoPat), geoPat);
// Which measure: a job that names neither area nor perimeter.
const which = await page.evaluate(() => {
  const qs = Array.from({ length: 400 }, () => genGeo('which')), bad = [];
  for (const q of qs) {
    if (/\b(area|perimeter)\b/i.test(q.text)) bad.push('names the measure: ' + q.text);
    const other = q.ask === 'area' ? 2 * (q.shape.w + q.shape.h) : q.shape.w * q.shape.h;
    const w = q.wrongs.find(x => x.v === other);
    if (!w || !/^(perim|area)$/.test(w.cls)) bad.push('the other measure is not a listed wrong answer: ' + q.desc);
    if (q.desc.length > 200 || q.steps.some(t => t.length > 160)) bad.push('too long for Teach me this: ' + q.desc);
  }
  return { bad: bad.slice(0, 3), badCount: bad.length, asks: [...new Set(qs.map(q => q.ask))].sort().join(','), jobs: new Set(qs.map(q => q.text)).size };
});
check('which measure: jobs that go around and jobs that cover, never named, with the other measure as a listed wrong answer',
  which.badCount === 0 && which.asks === 'area,perim' && which.jobs === 6, JSON.stringify(which));
await page.evaluate(() => {
  localStorage.clear(); Stats.reset();
  startGeoPractice();
  let q;
  do q = genGeo('which'); while (q.ask !== 'perim' || q.unit !== 'm');
  state.quiz[0] = { ...q, id: 0, given: '' };
  render();
});
const wCard = await page.evaluate(() => {
  const c = document.querySelector('.qcard'), q = state.quiz[0];
  return { unit: !!c.querySelector('.geo-unit'), labels: [...c.querySelectorAll('.geo-lbl')].map(t => t.textContent).join(','),
           named: /\b(area|perimeter)\b/i.test(c.querySelector('.geo-q').textContent), w: q.shape.w, h: q.shape.h };
});
check('the job card shows the sides but no answer unit, since the unit would name the measure',
  !wCard.unit && !wCard.named && wCard.labels === `${wCard.w} m,${wCard.h} m`, JSON.stringify(wCard));
const wBox = await (await page.$$('.qcard'))[0].$('input');
await wBox.fill(String(wCard.w * wCard.h)); await wBox.press('Enter');
await page.waitForTimeout(150);
const wHint = await page.evaluate(() => document.querySelector('.qcard .fixpill.hintpill').textContent);
check('practice: covering the inside instead of going around is named, without the answer',
  /would cover the inside/.test(wHint) && /the edge, so add all four sides/.test(wHint) && !wHint.includes(String(2 * (wCard.w + wCard.h))), wHint);
await wBox.fill(String(2 * (wCard.w + wCard.h))); await wBox.press('Enter');
await page.waitForTimeout(150);
const wDone = await page.evaluate(() => ({ imm: state.quiz[0]._imm, err: errEntry(state.quiz[0]) }));
check('…the right second try locks it, and the first try is logged as an area/perimeter mix-up',
  wDone.imm === 'fixed' && wDone.err.k === 'geo.which' && wDone.err.mix === true, JSON.stringify(wDone));
await page.evaluate(() => { state.showLesson = 'geo'; render(); });
await page.waitForTimeout(200);
check('the area & perimeter lesson opens with its figures and offers practice',
  await page.evaluate(() => { const m = document.querySelector('.modal'); return !!m && m.querySelectorAll('.geo-fig svg').length === 2 && /Try some/.test(m.textContent); }));
await page.evaluate(() => { state.showLesson = null; localStorage.clear(); });

console.log('18. 2-digit × 2-digit: area model, missing cross products, unlock, leaner expert mix');
await page.evaluate(() => { localStorage.clear(); });
await page.goto(base);
await page.waitForSelector('.ready-start, .qcard');
const m2 = await page.evaluate(() => {
  localStorage.clear(); Stats.reset();
  for (let r = 0; r < 8; r++) for (let a = 2; a <= 12; a++) for (let b = a; b <= 12; b++) Stats.recordMul(a, b, true, 2000);
  Stats.checkUnlocks();
  const seq = [true, false, true, true, true, true, true].map(ok => { Stats.recordSkill('bigmul', ok, 9000); return Stats.checkUnlocks(); });
  const earlyUnlock = seq.some(Boolean);
  Stats.recordSkill('bigmul', true, 9000);
  const newly = Stats.checkUnlocks();
  const bad = [];
  let wrongs = 0;
  for (let i = 0; i < 1500; i++) {
    const q = genMul2();
    if (q.ans !== q.a * q.b || q.a % 10 === 0) bad.push(`${q.a} × ${q.b} = ${q.ans}`);
    for (const st of q.steps) for (const m of st.matchAll(/(\d+) × (\d+) = (\d+)(?![\d ]*×)/g)) if (+m[1] * +m[2] !== +m[3]) bad.push('step: ' + st);
    const last = q.steps[q.steps.length - 1];
    if (last.split(' = ')[1] != q.ans || (q.mk === 'full' && last.split(' = ')[0].split(' + ').reduce((x, y) => x + +y, 0) !== q.ans)) bad.push('last: ' + last);
    for (const w of q.wrongs) { wrongs++; if (diagnose(q, String(w.v)).why !== w.why) bad.push(`diagnosis ${q.mk}/${w.cls}`); }
  }
  const q = { ...genMul2('full'), a: 34, b: 26, ans: 884 };
  const fresh = genMul2('full');
  const cross = fresh.wrongs.find(w => w.cls === 'cross');
  Stats.importMerge({ unlocked: { word: true, longdiv: true, multi: true, geo: true } });
  const quizzes = Array.from({ length: 40 }, () => newQuiz());
  return { earlyUnlock, newly, bad: bad.slice(0, 3), badCount: bad.length, wrongs,
           crossListed: !!cross && cross.v === (fresh.a - fresh.a % 10) * (fresh.b - fresh.b % 10) + (fresh.a % 10) * (fresh.b % 10),
           lens: [...new Set(quizzes.map(z => z.length))].join(','),
           addSub: Math.max(...quizzes.map(z => z.filter(x => x.type === 'add' || x.type === 'sub').length)),
           mul2Min: Math.min(...quizzes.map(z => z.filter(x => x.type === 'mul2').length)) };
});
check('unlocks only at 7 of the last 8 two-digit × one-digit right', !m2.earlyUnlock && m2.newly === 'mul2', JSON.stringify({ early: m2.earlyUnlock, newly: m2.newly }));
check('1500 problems: every partial product is true and they add up to the answer', m2.badCount === 0, m2.bad.join('; '));
check('tens×tens + ones×ones is listed as the missing-cross-products error', m2.crossListed);
check('every listed wrong answer is diagnosed with its own reason', m2.badCount === 0 && m2.wrongs > 3000, `${m2.wrongs} checked`);
check('expert with learning domains: still 10 questions, one + and one −, 2-digit × 2-digit in every quiz',
  m2.lens === '10' && m2.addSub === 2 && m2.mul2Min >= 1, JSON.stringify(m2));

await page.evaluate(() => {
  localStorage.clear(); Stats.reset();
  startMul2Practice(); state.immediate = false;
  state.quiz[0] = { ...genMul2('full'), a: 34, b: 26, ans: 884, id: 0, given: '', scaffold: null,
    steps: ['Split: 34 = 30 + 4 and 26 = 20 + 6', '30 × 20 = 600,  30 × 6 = 180', '4 × 20 = 80,  4 × 6 = 24', '600 + 180 + 80 + 24 = 884'],
    wrongs: [{ v: 624, cls: 'cross', why: 'You did 30 × 20 and 4 × 6, but missed 30 × 6 and 4 × 20. Every part of 34 multiplies every part of 26: four products.' }] };
  state.quiz[1] = { ...genMul2('full'), id: 1, given: '', scaffold: { kind: 'rows' } };
  render();
});
const m2Scaf = await page.evaluate(() => { const q = state.quiz[1]; return document.querySelectorAll('.qcard')[1].textContent.includes(`${q.a} × ${q.b - q.b % 10} + ${q.a} × ${q.b % 10} = ${q.a * (q.b - q.b % 10)} + ${q.a * (q.b % 10)} =`); });
check('a learner sees the two rows worked out and finishes the sum', m2Scaf);
const nM2 = await page.evaluate(() => state.quiz.length);
for (let i = 0; i < nM2; i++) {
  const q = await page.evaluate(i => state.quiz[i], i);
  await (await (await page.$$('.qcard'))[i].$('input')).fill(i === 0 ? '624' : String(q.ans));
}
await page.click('button:has-text("Check answers")');
await page.waitForTimeout(400);
const m2Run = await page.evaluate(() => {
  const raw = Stats.exportRaw(), sk = raw.skills.mul2 || {};
  return { wrong: state.quiz.filter(q => !answerCorrect(q)).length, n: state.quiz.filter(q => q.type === 'mul2').length,
    right: sk.right || 0, recorded: (sk.right || 0) + (sk.wrong || 0), err: raw.errlog.slice(-1)[0] || {},
    row: raw.hist.slice(-1)[0].q[0] || [], diag: document.querySelector('.qcard .diag').textContent,
    teach: JSON.stringify(teachPayload(state.quiz[0])),
    pat: (Stats.recordError({ d: Date.now() + 5, k: 'mul2.full', x: [23, 45], g: '815', ans: '1035', cross: true }),
          (Stats.errorPatterns().find(p => p.key === 'mul2.full') || {}).kind) };
});
check('2-digit × 2-digit practice grades through the real inputs', m2Run.wrong === 1 && m2Run.recorded === m2Run.n && m2Run.right === m2Run.n - 1, `${m2Run.right}/${m2Run.recorded} of ${m2Run.n}`);
check('the missed cross products are logged, named on the card, and become a pattern',
  m2Run.err.k === 'mul2.full' && m2Run.err.cross === true && /missed 30 × 6 and 4 × 20/.test(m2Run.diag) && /600 \+ 180 \+ 80 \+ 24 = 884/.test(m2Run.diag) && m2Run.pat === 'misconception',
  JSON.stringify(m2Run.err));
check('the daily log row and "Teach me this" carry the problem', m2Run.row[0] === '34 × 26' && m2Run.row[1] === '624' && m2Run.teach === '{"type":"mul2","a":34,"b":26}', JSON.stringify(m2Run.row));
await page.evaluate(() => { state.showLesson = 'mul2'; render(); });
await page.waitForTimeout(200);
check('the lesson shows the four-box area model', await page.evaluate(() => document.querySelectorAll('.modal .m2-cell').length === 4));
await page.evaluate(() => { state.showLesson = null; localStorage.clear(); });

console.log('19. fractions level 2: adding like fractions and the number line');
await page.evaluate(() => { localStorage.clear(); });
await page.goto(base);
await page.waitForSelector('.ready-start, .qcard');
const fr = await page.evaluate(() => {
  localStorage.clear(); Stats.reset();
  for (let r = 0; r < 8; r++) for (let a = 2; a <= 12; a++) for (let b = a; b <= 12; b++) Stats.recordMul(a, b, true, 2000);
  Stats.checkUnlocks();
  const types = () => [...new Set(Array.from({ length: 300 }, () => genFraction().type))].sort().join(',');
  const before = types();
  for (let i = 0; i < 6; i++) Stats.recordSkill('frac.fnam', true, 9000);
  const at1 = Stats.checkUnlocks();
  for (let i = 0; i < 6; i++) Stats.recordSkill('frac.feq', true, 9000);
  const at2 = Stats.checkUnlocks();                 // two basics, but not the number line
  for (let i = 0; i < 6; i++) Stats.recordSkill('frac.fpos', true, 9000);
  const at3 = Stats.checkUnlocks();
  const after = types();
  const bad = [];
  const g = (q, n, d) => ({ ...q, givenNum: String(n), givenDen: String(d) });
  for (let i = 0; i < 1500; i++) {
    const a = genFracAdd();
    if (a.ansNum !== (a.op === '+' ? a.n1 + a.n2 : a.n1 - a.n2) || !(a.ansNum > 0 && a.ansNum < a.d)) bad.push(`fadd ${a.n1}${a.op}${a.n2}/${a.d}`);
    if (!answerCorrect(g(a, a.ansNum, a.d)) || !answerCorrect(g(a, 2 * a.ansNum, 2 * a.d))) bad.push('equivalent answer refused');
    const addden = a.op === '+' ? g(a, a.n1 + a.n2, 2 * a.d) : g(a, a.n1 - a.n2, 0);
    if (answerCorrect(addden) || fracOpMiss(addden) !== 'addden') bad.push(`bottoms added not caught: ${a.n1}${a.op}${a.n2}/${a.d}`);
    const l = genFracLine();
    if (!(l.k > 0 && l.k < l.d * l.max && l.k !== l.d)) bad.push(`fline ${l.k}/${l.d}`);
    if (numberLineEl(l.d, l.max, l.k).querySelectorAll('.nl-tick,.nl-major').length !== l.d * l.max + 1) bad.push('tick count');
    if (!answerCorrect(g(l, l.k, l.d)) || answerCorrect(g(l, l.k, l.d + 1)) || fracOpMiss(g(l, l.k, l.d + 1)) !== 'ticks') bad.push(`ticks not caught: ${l.k}/${l.d}`);
  }
  return { before, at1, at2, at3, after, bad: bad.slice(0, 3), badCount: bad.length,
           practice: fractionQuiz().filter(q => q.type === 'fadd' || q.type === 'fline').length };
});
check('adding and reading the line open once the number line and one more basic are solid (two other basics are not enough)',
  fr.before === 'fcmp,feq,ferr,fnam,fpos' && !fr.at1 && !fr.at2 && fr.at3 === 'fracops' && fr.after === 'fadd,fcmp,feq,ferr,fline,fnam,fpos', JSON.stringify(fr));
check('1500 of each: sums in range, equivalent answers accepted, added bottoms and counted ticks caught', fr.badCount === 0, fr.bad.join('; '));
check('fraction practice covers both new kinds', fr.practice >= 2, `${fr.practice}`);

await page.evaluate(() => {
  localStorage.clear(); Stats.reset(); Stats.importMerge({ unlocked: { fractions: true, fracops: true } });
  startFractionPractice(); state.immediate = false;
  state.quiz[0] = { type: 'fadd', op: '+', n1: 3, n2: 2, d: 8, ansNum: 5, ansDen: 8, label: 'Fractions · add', isReview: false, id: 0, given: '' };
  state.quiz[1] = { type: 'fline', d: 4, max: 1, k: 3, ansNum: 3, ansDen: 4, label: 'Fractions · number line', isReview: false, id: 1, given: '' };
  state.quiz[2] = { type: 'fline', d: 3, max: 2, k: 4, ansNum: 4, ansDen: 3, label: 'Fractions · number line', isReview: false, id: 2, given: '' };
  render();
});
const frIn = { 0: ['5', '16'], 1: ['3', '5'], 2: ['8', '6'] };
const nFr = await page.evaluate(() => state.quiz.length);
for (let i = 0; i < nFr; i++) {
  const q = await page.evaluate(i => state.quiz[i], i);
  const card = (await page.$$('.qcard'))[i];
  if (['fadd', 'fline', 'fnam'].includes(q.type)) {
    const [a, b] = await card.$$('input.frac-in');
    const v = frIn[i] || [String(q.ansNum), String(q.ansDen)];
    await a.fill(v[0]); await b.fill(v[1]);
  } else if (q.type === 'fcmp' || q.type === 'ferr') await answerChoice(i, q);
  else if (q.type === 'fpos') await placeAt(card, q.n / q.d, q.max);
  else await (await card.$('input')).fill(String(q.ans));
}
await page.click('button:has-text("Check answers")');
await page.waitForTimeout(400);
const frRun = await page.evaluate(() => {
  const raw = Stats.exportRaw();
  return { wrong: state.quiz.map((q, i) => answerCorrect(q) ? null : i).filter(x => x !== null).join(','),
    errs: raw.errlog.slice(-2).map(e => `${e.k}:${e.g}:${e.addden ? 'addden' : e.ticks ? 'ticks' : '-'}`).join(' '),
    rows: raw.hist.slice(-1)[0].q.slice(0, 3).map(r => r.slice(0, 4).join('|')),
    diag: [...document.querySelectorAll('.qcard')].slice(0, 2).map(c => (c.querySelector('.diag') || {}).textContent || ''),
    teach: JSON.stringify([teachPayload(state.quiz[0]), teachPayload(state.quiz[1])]) };
});
check('fraction row inputs grade: added bottoms and counted ticks wrong, 8/6 for 4/3 right', frRun.wrong === '0,1', frRun.wrong);
check('both misconceptions are logged', frRun.errs === 'fadd:5/16:addden fline:3/5:ticks', frRun.errs);
check('the cards explain them', /added the bottom numbers too/.test(frRun.diag[0]) && /still eighths/.test(frRun.diag[0]) && /counted the tick marks/.test(frRun.diag[1]));
check('the daily log shows what was typed', frRun.rows[0] === '3/8 + 2/8|5/16|5/8|0' && frRun.rows[2] === 'number line 0–2, dot at 4/3|8/6|4/3|1', JSON.stringify(frRun.rows));
check('"Teach me this" sends both kinds', frRun.teach === '[{"type":"fadd","n1":3,"n2":2,"d":8,"op":"+"},{"type":"fline","k":3,"d":4,"max":1}]', frRun.teach);
await page.evaluate(() => { state.showLesson = 'fracops'; render(); });
await page.waitForTimeout(200);
check('the lesson shows the bars and two number lines', await page.evaluate(() => document.querySelectorAll('.modal .nl-fig svg').length === 2 && document.querySelectorAll('.modal .frac-vis').length === 2));
await page.evaluate(() => { state.showLesson = null; localStorage.clear(); });

console.log('20. fractions stay in every quiz, and in the warm-up, until every fraction skill is solid');
await page.evaluate(() => { localStorage.clear(); });
await page.goto(base);
await page.waitForSelector('.ready-start, .qcard');
const al = await page.evaluate(() => {
  localStorage.clear(); Stats.reset();
  for (let r = 0; r < 8; r++) for (let a = 2; a <= 12; a++) for (let b = a; b <= 12; b++) Stats.recordMul(a, b, true, 2000);
  Stats.checkUnlocks();
  Stats.importMerge({ unlocked: { longdiv: true, multi: true, mul2: true } });  // every domain open
  const nFrac = qs => qs.filter(isFracQ).length;
  const stat = list => ({ min: Math.min(...list.map(nFrac)), max: Math.max(...list.map(nFrac)),
    mean: Math.round(100 * list.reduce((s, q) => s + nFrac(q), 0) / list.length) / 100, lens: [...new Set(list.map(q => q.length))].sort().join(',') });
  const many = (n, f) => Array.from({ length: n }, f);
  const learnBand = difficultyBand();
  const learnQ = stat(many(60, () => newQuiz())), learnW = stat(many(40, () => focusQuiz(true)));
  // the last quizzes came in under 70%: one band down, to practicing
  const t0 = Date.now() - 3600000;
  Stats.importMerge({ hist: [0, 1, 2].map(i => ({ d: t0 + i * 60000, n: 10, c: 6, t: 300, k: 'quiz' })) });
  const lowBand = difficultyBand(), practQ = stat(many(60, () => newQuiz()));
  for (const k of ['fnam', 'feq', 'fcmp', 'fpos', 'ferr']) for (let i = 0; i < 6; i++) { Stats.recordSkill('fractions', true, 9000); Stats.recordSkill('frac.' + k, true, 9000); }
  const newly = Stats.checkUnlocks();
  const opsOpenLearning = !Stats.fracSolid();          // level 2 just opened: still learning
  for (const k of ['fadd', 'fline']) for (let i = 0; i < 6; i++) { Stats.recordSkill('fractions', true, 9000); Stats.recordSkill('frac.' + k, true, 9000); }
  const solidPract = stat(many(60, () => newQuiz()));
  Stats.importMerge({ hist: [3, 4, 5, 6, 7].map(i => ({ d: t0 + i * 60000, n: 10, c: 10, t: 300, k: 'quiz' })) });
  return { learnBand, learnQ, learnW, lowBand, practQ, newly, opsOpenLearning, solid: Stats.fracSolid(), solidPract,
           topBand: difficultyBand(), solidQ: stat(many(200, () => newQuiz())), solidW: stat(many(40, () => focusQuiz(true))) };
});
check('not yet solid, top band, every domain open: every quiz has a fraction question and 10 questions',
  al.learnBand === 'expert' && al.learnQ.min >= 1 && al.learnQ.lens === '10', JSON.stringify({ band: al.learnBand, ...al.learnQ }));
check('not yet solid: the warm-up carries exactly one, and stays at 5-6 questions',
  al.learnW.min === 1 && al.learnW.max === 1 && /^[56](,[56])?$/.test(al.learnW.lens), JSON.stringify(al.learnW));
check('one band down (practicing, every domain open): 10 questions, and fractions are not trimmed',
  al.lowBand === 'practicing' && al.practQ.lens === '10' && al.practQ.min >= 1, JSON.stringify({ band: al.lowBand, ...al.practQ }));
check('level 2 opening keeps fractions in the learning slots until adding and reading the line are solid too',
  al.newly === 'fracops' && al.opsOpenLearning && al.solid, JSON.stringify({ newly: al.newly, learning: al.opsOpenLearning, solid: al.solid }));
check('practicing with every domain open and fractions solid: 10 questions, not 11', al.solidPract.lens === '10', JSON.stringify(al.solidPract));
check('all solid at the top band: fractions go back into rotation, none in the warm-up',
  al.topBand === 'expert' && al.solidQ.min === 0 && al.solidQ.mean > 0.1 && al.solidQ.mean < 0.5 && al.solidW.max === 0,
  JSON.stringify({ band: al.topBand, quiz: al.solidQ, warm: al.solidW }));

console.log('21. placing fractions on the number line: kinds, grading, misconceptions, real taps, practice fix, lesson');
const np = await page.evaluate(() => {
  localStorage.clear(); Stats.reset(); Stats.importMerge({ unlocked: { fractions: true } });
  const bad = [];
  const early = new Set(Array.from({ length: 300 }, () => genFracPos().fk));
  for (let i = 0; i < 4; i++) Stats.recordSkill('frac.fpos', true, 3000);
  Stats.recordSkill('frac.fpos', false, 3000);       // 4 right, not yet solid: cuts still offered
  const later = new Set();
  let cuts = 0;
  for (let i = 0; i < 1500; i++) {
    const q = genFracPos(), v = q.n / q.d, at = g => answerCorrect({ ...q, given: String(g) });
    later.add(q.fk); if (q.ticks) cuts++;
    if (!(v > 0 && v <= q.max) || q.ansNum !== q.n || q.ansDen !== q.d || answerText(q) !== `${q.n}/${q.d}`) bad.push(`range ${q.n}/${q.d} on 0-${q.max}`);
    if ({ unit: !(q.n === 1 && q.max === 1), below: !(q.n >= 2 && v < 1 && q.max === 1), one: !(v === 1 && q.max === 2),
          past: !(v > 1 && v < 2 && q.max === 2), below2: !(v < 1 && q.max === 2) }[q.fk]) bad.push(`${q.fk} ${q.n}/${q.d} on 0-${q.max}`);
    if (q.max === 2 && !q.ticks && q.d > 4) bad.push(`pieces too fine without cuts: ${q.n}/${q.d}`);
    if (!!q.scaffold !== q.ticks) bad.push('scaffold flag');
    if (!at(v)) bad.push(`exact point refused ${q.n}/${q.d}`);
    if (q.ticks && (at(v + 1 / q.d) || at(v - 1 / q.d))) bad.push(`next cut accepted ${q.n}/${q.d}`);
    if (!q.ticks) {
      const tol = fposTol(q);
      if (!at(v + 0.9 * tol) || !at(v - 0.9 * tol)) bad.push(`near miss refused ${q.n}/${q.d}`);
      if (at(v + 1.5 * tol) || at(v - 1.5 * tol)) bad.push(`far miss accepted ${q.n}/${q.d}`);
      if (tol * q.d >= 0.5) bad.push(`tolerance reaches the next fraction ${q.n}/${q.d}`);
    }
    if (diagnose(q, '').why !== 'You did not put a mark on the line.') bad.push('blank diagnosis');
  }
  const mk = (n, d, max, ticks, g) => ({ type: 'fpos', n, d, max, ticks, given: String(g), ansNum: n, ansDen: d });
  const miss = [mk(1, 8, 1, true, 7 / 8), mk(3, 4, 1, true, 2 / 4), mk(1, 2, 2, false, 1), mk(3, 4, 1, true, 1 / 4), mk(5, 4, 2, false, 0.6),
                mk(3, 8, 1, false, 0.8), mk(2, 3, 1, false, 0.75), mk(2, 3, 2, false, 2), mk(3, 4, 1, true, '')].map(fposMiss).join(',');
  return { bad: bad.slice(0, 3), badCount: bad.length, early: [...early].sort().join(','), later: [...later].sort().join(','), cuts, miss,
           gap: fposGap(mk(3, 4, 1, true, 0.5)), why: fposWhy(mk(1, 8, 1, true, 7 / 8), 'bigden') };
});
check('kinds: unit fractions and a/b below 1 first; 1, past 1 and the 0-2 line once a few are right',
  np.early === 'below,unit' && np.later === 'below,below2,one,past,unit', `${np.early} → ${np.later}`);
check('1500 problems: on the line, right kind, cuts as a scaffold on about half, fine pieces only with cuts',
  np.badCount === 0 && np.cuts > 500 && np.cuts < 1000, np.bad.join('; ') || `cuts ${np.cuts}`);
check('grading: the right cut only; without cuts within about 6% of the line, never as far as the next fraction', np.badCount === 0);
check('misconception classes: big bottom, 0 counted as a jump, whole line as one, from the right, wrong side of 1, of a half, close, the top as a whole number, blank',
  np.miss === 'bigden,countzero,wholeline,fromright,side1,half,close,numwhole,blank', np.miss);
check('the miss is told in jumps, and the big-bottom error is explained', np.gap === '1 jump of 1/4 too far left' && /More pieces means smaller pieces/.test(np.why), `${np.gap} / ${np.why}`);

// the child taps through a graded practice set: 3/4 one jump short, 1/3 and 5/4 estimated well
await page.evaluate(() => {
  localStorage.clear(); Stats.reset(); Stats.importMerge({ unlocked: { fractions: true }, seen: { fractionsLesson: true, fracLineLesson: true } });
  startFractionPractice(); state.immediate = false;
  const pin = (i, o) => { state.quiz[i] = { ...genFracPos(o.fk), ...o, ans: o.n / o.d, ansNum: o.n, ansDen: o.d, scaffold: o.ticks ? { kind: 'ticks' } : null,
    steps: [`${o.n}/${o.d} is ${o.n} jumps of 1/${o.d} from 0`], id: i, given: '' }; };
  pin(0, { fk: 'below', n: 3, d: 4, max: 1, ticks: true });
  pin(1, { fk: 'unit', n: 1, d: 3, max: 1, ticks: false });
  pin(2, { fk: 'past', n: 5, d: 4, max: 2, ticks: false });
  render();
});
const npAt = { 0: 0.5, 1: 0.36, 2: 1.31 };
const nNp = await page.evaluate(() => state.quiz.length);
for (let i = 0; i < nNp; i++) {
  const q = await page.evaluate(i => state.quiz[i], i);
  const card = (await page.$$('.qcard'))[i];
  if (q.type === 'fpos') await placeAt(card, i in npAt ? npAt[i] : q.n / q.d, q.max);
  else if (q.type === 'fnam') { const [a, b] = await card.$$('input.frac-in'); await a.fill(String(q.ansNum)); await b.fill(String(q.ansDen)); }
  else if (q.type === 'fcmp' || q.type === 'ferr') await answerChoice(i, q);
  else await (await card.$('input')).fill(String(q.ans));
}
await page.click('button:has-text("Check answers")');
await page.waitForTimeout(400);
const npRun = await page.evaluate(() => {
  const raw = Stats.exportRaw(), sk = raw.skills['frac.fpos'] || {}, card = document.querySelector('.qcard');
  state.showStats = true; render();
  document.querySelectorAll('details.stats-group').forEach(d => d.open = true);
  const panel = document.querySelector('.modal').textContent;
  state.showStats = false; render();
  return {
    wrong: state.quiz.map((q, i) => answerCorrect(q) ? null : i).filter(x => x !== null).join(','),
    nPos: state.quiz.filter(q => q.type === 'fpos').length, unaided: state.quiz.filter(q => q.type === 'fpos' && !q.ticks).length,
    right: sk.right || 0, wrongN: sk.wrong || 0, pe: sk.pe || [],
    err: raw.errlog.slice(-1)[0] || {}, row: raw.hist.slice(-1)[0].q[0] || [],
    card: card.textContent, jumps: card.querySelectorAll('.fpos-jump').length, ans: card.querySelectorAll('.fpos-ans').length,
    teach: JSON.stringify(teachPayload(state.quiz[0])), aim: (panel.match(/🎯 Number-line aim.*?lower is better/) || [''])[0],
  };
});
check('placements grade through real taps: only the one-jump-short mark is wrong', npRun.wrong === '0', `wrong=${npRun.wrong}`);
check('every placement is recorded on the number-line skill', npRun.right === npRun.nPos - 1 && npRun.wrongN === 1, `${npRun.right}+${npRun.wrongN} of ${npRun.nPos}`);
check('the miss size is kept for unaided placements only, all inside the tolerance here',
  npRun.pe.length === npRun.unaided && npRun.pe.every(x => x < 6), JSON.stringify({ pe: npRun.pe, unaided: npRun.unaided }));
check('the miss is logged as counting the 0 mark, with the mark it snapped to', npRun.err.k === 'fpos' && npRun.err.zero === true && npRun.err.g === '2/4' && npRun.err.ans === '3/4', JSON.stringify(npRun.err));
check('the card shows the answer with its three jumps, says how far off, and why', npRun.ans === 1 && npRun.jumps === 3 &&
  /Your mark: 1 jump of 1\/4 too far left/.test(npRun.card) && /One jump short/.test(npRun.card) && /1\/4 \+ 1\/4 \+ 1\/4 = 3\/4/.test(npRun.card));
check('the daily log row says what was asked and where it went', npRun.row.slice(0, 4).join('|') === 'number line 0–1: put 3/4|2/4|3/4|0', JSON.stringify(npRun.row));
check('"Teach me this" sends the fraction and the mark', npRun.teach === '{"type":"fpos","n":3,"d":4,"max":1,"placed":0.5}', npRun.teach);
check('the parent panel shows the number-line aim', /off by [\d.]+% of the line on average over the last \d/.test(npRun.aim), npRun.aim);

// practice mode: a miss is fixed by counting jumps on the cut line, then copying
await page.evaluate(() => {
  startFractionPractice();
  state.quiz[0] = { ...genFracPos('below'), n: 3, d: 4, max: 1, ticks: false, scaffold: null, ans: 0.75, ansNum: 3, ansDen: 4, id: 0, given: '' };
  render();
});
const c0 = async () => (await page.$$('.qcard'))[0];
await placeAt(await c0(), 0.1, 1);
await (await (await c0()).$('.fpos-check')).click();
await page.waitForTimeout(150);
const fx1 = await page.evaluate(() => { const c = document.querySelector('.qcard');
  return { cls: c.className, pill: (c.querySelector('.fixpill') || {}).textContent || '', cuts: c.querySelectorAll('.nl-tick').length, ans: c.querySelectorAll('.fpos-ans').length }; });
check('practice: a miss names the reason and asks to count jumps, on a line that now shows the cuts',
  /imm-fixing/.test(fx1.cls) && /more than half/.test(fx1.pill) && /Count 3 jumps of 1\/4 from 0/.test(fx1.pill) && fx1.cuts === 3 && fx1.ans === 0, JSON.stringify(fx1));
await placeAt(await c0(), 0.5, 1);
const fx2 = await page.evaluate(() => { const c = document.querySelector('.qcard'); return { ans: c.querySelectorAll('.fpos-ans').length, pill: c.querySelector('.fixpill').textContent }; });
check('a second miss shows the answer and its jumps to copy', fx2.ans === 1 && /The green dot is 3\/4/.test(fx2.pill), JSON.stringify(fx2));
await placeAt(await c0(), 0.75, 1);
const fx3 = await page.evaluate(() => ({ cls: document.querySelector('.qcard').className, given: state.quiz[0].given, right: answerCorrect(state.quiz[0]),
  note: (document.querySelector('.qcard .fpos-note') || {}).textContent || '' }));
check('placing it right locks the card; the first try is still what gets graded', /imm-fixed/.test(fx3.cls) && fx3.given === '0.1' && !fx3.right && /Fixed: 3\/4 = 3 jumps of 1\/4/.test(fx3.note), JSON.stringify(fx3));
await page.evaluate(() => {
  state.quiz[1] = { ...genFracPos('below'), n: 2, d: 3, max: 1, ticks: true, scaffold: { kind: 'ticks' }, ans: 2 / 3, ansNum: 2, ansDen: 3, id: 1, given: '' };
  render(); document.querySelectorAll('.qcard')[1].querySelector('.fpos-fig svg').focus();
});
// first press puts the marker at 0, then one cut per press: 0, 1/3, 2/3, 1, back to 2/3
for (const key of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowLeft']) await page.keyboard.press(key);
check('arrow keys move the marker one cut at a time', await page.evaluate(() => Math.abs(Number(state.quiz[1].given) - 2 / 3) < 1e-9), await page.evaluate(() => state.quiz[1].given));
const npPat = await page.evaluate(() => {
  Stats.recordError({ d: Date.now() + 5, k: 'fpos', x: [1, 6, 1], g: '5/6', ans: '1/6', bigden: true });
  Stats.recordError({ d: Date.now() + 6, k: 'fpos', x: [1, 8, 1], g: '0.85', ans: '1/8', bigden: true });
  return Stats.errorPatterns().filter(p => p.key === 'fpos').map(p => p.kind + ': ' + p.label)[0] || '';
});
check('putting 1/8-type fractions far along becomes a named misconception for the parent', /^misconception: .*bigger bottom/.test(npPat), npPat);

// a child who had fractions before this release sees the new lesson once, on open
await page.evaluate(() => {
  localStorage.clear(); Stats.reset();
  Stats.importMerge({ unlocked: { fractions: true }, seen: { fractionsLesson: true } });
  localStorage.removeItem('mathquiz.session.v1');
});
await page.reload();
await page.waitForSelector('.modal');
const intro = await page.evaluate(() => ({ title: document.querySelector('.modal h2').textContent, lines: document.querySelectorAll('.modal .nl-fig svg').length,
  text: document.querySelector('.modal').textContent }));
check('existing fraction learners get the number-line lesson on open: jumps, past 1, more pieces = smaller, same place = same number',
  /New in fractions: the number line/.test(intro.title) && intro.lines === 5 && /1\/4 \+ 1\/4 \+ 1\/4/.test(intro.text) && /1\/8 < 1\/3/.test(intro.text) && /1\/2 = 2\/4/.test(intro.text),
  JSON.stringify({ title: intro.title, lines: intro.lines }));
await page.click('.modal button:has-text("Later")');
await page.reload();
await page.waitForSelector('.ready-start, .qcard');
check('…and only once', !(await page.$('.modal')) && await page.evaluate(() => Stats.hasSeen('fracLineLesson')));
await page.evaluate(() => { localStorage.clear(); });

console.log('22. fractions: compare with a reason, spot the mistake, pictures beyond the bar');
await page.goto(base);
await page.waitForSelector('.ready-start, .qcard');
const f3 = await page.evaluate(() => {
  localStorage.clear(); Stats.reset(); Stats.importMerge({ unlocked: { fractions: true } });
  const bad = [], kinds = new Set(), shapes = new Set(), ekinds = new Set();
  let trueClaims = 0;
  for (let i = 0; i < 1500; i++) {
    const q = genFracCompare(), v1 = q.n1 / q.d1, v2 = q.n2 / q.d2;
    kinds.add(q.ck);
    if (q.ans !== (v1 < v2 ? '<' : v1 > v2 ? '>' : '=')) bad.push(`sign ${q.n1}/${q.d1} ${q.ans} ${q.n2}/${q.d2}`);
    if ({ den: q.d1 !== q.d2 || q.n1 === q.n2, num: q.n1 !== q.n2 || q.d1 === q.d2, eq: v1 !== v2,
          half: !((v1 < 0.5 && v2 > 0.5) || (v1 > 0.5 && v2 < 0.5)) || q.d1 === q.d2 || q.n1 === q.n2,
          one: q.n1 !== q.d1 - 1 || q.n2 !== q.d2 - 1 || q.d1 === q.d2 }[q.ck]) bad.push(`kind ${q.ck}: ${q.n1}/${q.d1} vs ${q.n2}/${q.d2}`);
    if (q.whys.length !== 3 || new Set(q.whys).size !== 3 || !q.whys.includes(q.ck) || !q.whys.includes('big')) bad.push('reasons ' + q.whys);
    if (q.ck === 'den' && q.whys.includes('top')) bad.push('a true reason offered as a decoy');
    const g = (sign, why) => answerCorrect({ ...q, given: sign, givenWhy: why });
    if (!g(q.ans, q.ck) || g(q.ans, q.whys.find(k => k !== q.ck)) || g(q.ans === '<' ? '>' : '<', q.ck)) bad.push('grading ' + q.ck);
    if (/undefined|NaN/.test(fcmpExplain(q))) bad.push('explanation ' + q.ck);
    const e = genFracErr();
    ekinds.add(e.ek); if (e.right) trueClaims++;
    if (e.opts.map(o => o.k).sort().join(',') !== 'agree,decoy,fix' || e.ans !== (e.right ? 'agree' : 'fix')) bad.push('claim options ' + e.ek);
    if (/undefined|NaN/.test(e.claim + e.explain + e.opts.map(o => o.text).join())) bad.push('claim text ' + e.ek);
    if (e.pic && /undefined|NaN/.test(ferrPicEl(e.pic).outerHTML)) bad.push('claim picture ' + e.ek);
    if (!answerCorrect({ ...e, given: e.ans }) || answerCorrect({ ...e, given: e.right ? 'fix' : 'agree' })) bad.push('claim grading ' + e.ek);
    const n = genFracName(), fig = fracShapeEl(n);
    shapes.add(n.shape);
    const parts = fig.querySelectorAll('path, .frac-cell, .frac-dot').length, on = fig.querySelectorAll('path.on, .frac-cell.on, .frac-dot.on').length;
    if (parts !== n.den || on !== n.shaded || n.cells.length !== n.shaded) bad.push(`picture ${n.shape} ${n.shaded}/${n.den}: ${on} of ${parts}`);
  }
  const legacyOk = answerCorrect({ type: 'fcmp', n1: 1, d1: 2, n2: 1, d2: 4, ans: '>', given: '>' });   // saved before reasons
  Stats.importMerge({ unlocked: { fracops: true } });
  const addLater = new Set(Array.from({ length: 600 }, () => genFracErr().ek)).has('addden');
  return { bad: bad.slice(0, 4), badCount: bad.length, kinds: [...kinds].sort().join(','), shapes: [...shapes].sort().join(','),
           ekinds: [...ekinds].sort().join(','), trueShare: trueClaims / 1500, legacyOk, addLater };
});
check('comparing: five kinds (same bottom, same top, equal, either side of a half, near 1), three reasons including the big-bottom decoy',
  f3.badCount === 0 && f3.kinds === 'den,eq,half,num,one', f3.bad.join('; ') || f3.kinds);
check('a comparison needs the right sign AND the right reason; ones saved before reasons still grade on the sign', f3.badCount === 0 && f3.legacyOk);
check('spot the mistake: each misconception plus true claims (about a third); the adding one waits for level 2',
  f3.ekinds === 'bigden,eq,flip,over1,past1,ticks,unequal,unit' && f3.trueShare > 0.25 && f3.trueShare < 0.42 && f3.addLater,
  `${f3.ekinds} true=${f3.trueShare.toFixed(2)} adding later=${f3.addLater}`);
check('naming pictures: bar, circle, grid and counters, shaded anywhere, every part drawn', f3.shapes === 'bar,circle,grid,set' && f3.badCount === 0, f3.shapes);

// graded set through the real buttons: the right sign for the big-bottom
// reason, and agreeing with a big-bottom claim
await page.evaluate(() => {
  localStorage.clear(); Stats.reset(); Stats.importMerge({ unlocked: { fractions: true }, seen: { fractionsLesson: true, fracLineLesson: true } });
  startFractionPractice(); state.immediate = false;
  state.quiz[0] = { ...genFracCompare('one'), n1: 7, d1: 8, n2: 5, d2: 6, ans: '>', id: 0, given: '' };
  state.quiz[1] = { ...genFracErr('bigden'), id: 1, given: '' };
  state.quiz[2] = { ...genFracName(), shape: 'circle', den: 6, cells: [0, 2, 3], shaded: 3, ansNum: 3, ansDen: 6, id: 2, given: '' };
  render();
});
const f3n = await page.evaluate(() => state.quiz.length);
for (let i = 0; i < f3n; i++) {
  const q = await page.evaluate(i => state.quiz[i], i);
  const card = (await page.$$('.qcard'))[i];
  if (i === 0) await answerChoice(0, q, { sign: '>', why: 'big' });
  else if (i === 1) await answerChoice(1, q, { key: 'agree' });
  else if (q.type === 'fcmp' || q.type === 'ferr') await answerChoice(i, q);
  else if (q.type === 'fpos') await placeAt(card, q.n / q.d, q.max);
  else if (q.type === 'fnam') { const [a, b] = await card.$$('input.frac-in'); await a.fill(String(q.ansNum)); await b.fill(String(q.ansDen)); }
  else await (await card.$('input')).fill(String(q.ans));
}
await page.click('button:has-text("Check answers")');
await page.waitForTimeout(400);
const f3r = await page.evaluate(() => {
  const raw = Stats.exportRaw(), cards = [...document.querySelectorAll('.qcard')];
  return { wrong: state.quiz.map((q, i) => answerCorrect(q) ? null : i).filter(x => x !== null).join(','),
    errs: raw.errlog.slice(-2), rows: raw.hist.slice(-1)[0].q.slice(0, 3).map(r => r.slice(1, 4).join('|')),
    diag0: (cards[0].querySelector('.diag') || {}).textContent || '', diag1: (cards[1].querySelector('.diag') || {}).textContent || '',
    teach: [teachPayload(state.quiz[0]), teachPayload(state.quiz[1])] };
});
check('graded through the real buttons: the right sign for a wrong reason is wrong, so is agreeing with the claim, the circle is right',
  f3r.wrong === '0,1', `wrong=${f3r.wrong}`);
check('logged as right-sign-wrong-reason with the big-bottom idea, and as fooled by a big-bottom claim',
  f3r.errs[0].k === 'fcmp' && f3r.errs[0].rw && f3r.errs[0].bigden && f3r.errs[0].g === '> · big bottom' && f3r.errs[1].k === 'ferr' && f3r.errs[1].fooled && f3r.errs[1].x[0] === 'bigden',
  JSON.stringify(f3r.errs));
check('the daily log shows the sign with its reason, and the answer to the claim', f3r.rows[0] === '> · big bottom|> · near 1|0' && f3r.rows[1] === 'agreed|no (real why)|0' && f3r.rows[2] === '3/6|3/6|1', JSON.stringify(f3r.rows));
check('the cards say "right sign, wrong reason" with the gap to 1, and name the claim\'s mistake',
  /Right sign, wrong reason/.test(f3r.diag0) && /1\/8 is the smaller gap/.test(f3r.diag0) && /made a mistake/.test(f3r.diag1) && /More pieces means smaller pieces/.test(f3r.diag1));
check('"Teach me this" sends the reason kind and the claim', f3r.teach[0].how === 'one' && f3r.teach[1].type === 'ferr' && f3r.teach[1].right === false && /bigger than/.test(f3r.teach[1].text), JSON.stringify(f3r.teach));
const f3pat = await page.evaluate(() => {
  Stats.recordError({ d: Date.now() + 5, k: 'fcmp', x: [5, 6, 3, 4], g: '> · big bottom', ans: '> · near 1', rw: true, bigden: true });
  Stats.recordError({ d: Date.now() + 6, k: 'ferr', x: ['bigden', '1 9 1 3 9 3'], g: 'agree', ans: 'fix', fooled: true });
  return Stats.errorPatterns().filter(p => p.key === 'fcmp' || p.key === 'ferr').map(p => `${p.key}:${p.kind}: ${p.label}`);
});
check('both become named misconceptions for the parent', f3pat.some(t => /^fcmp:misconception: .*bigger bottom/.test(t)) &&
  f3pat.some(t => /^ferr:misconception: .*a bigger bottom makes a bigger fraction/.test(t)), f3pat.join(' | '));

// practice mode: picking the sign shows the reasons; the reason locks it
await page.evaluate(() => {
  startFractionPractice();
  state.quiz[0] = { ...genFracCompare('half'), n1: 3, d1: 8, n2: 4, d2: 6, ans: '<', whys: ['half', 'big', 'top'], id: 0, given: '' };
  state.quiz[1] = { ...genFracErr('over1'), id: 1, given: '' };
  render();
});
const p0 = await page.evaluate(() => state.quiz[0]);
await (await (await page.$$('.qcard'))[0].$('.fcmp-btn:text-is("<")')).click();
await page.waitForTimeout(80);
const mid = await page.evaluate(() => ({ imm: state.quiz[0]._imm || null, reasons: document.querySelectorAll('.qcard')[0].querySelectorAll('.fcmp-why').length }));
await answerChoice(0, p0, { sign: '<', why: 'half' });
const done0 = await page.evaluate(() => ({ cls: document.querySelectorAll('.qcard')[0].className, note: (document.querySelectorAll('.qcard')[0].querySelector('.fcmp-note') || {}).textContent || '' }));
check('practice: the sign alone does not lock; the reason does, with the explanation',
  mid.imm === null && mid.reasons === 3 && /imm-good/.test(done0.cls) && /3\/8 is less than a half/.test(done0.note), JSON.stringify({ mid, done0 }));
await answerChoice(1, await page.evaluate(() => state.quiz[1]), { key: 'agree' });
const done1 = await page.evaluate(() => ({ cls: document.querySelectorAll('.qcard')[1].className, note: (document.querySelectorAll('.qcard')[1].querySelector('.fcmp-note') || {}).textContent || '' }));
check('practice: agreeing with a wrong claim locks it and says what the mistake was', /imm-fixed/.test(done1.cls) && /mistake: .* < 1/.test(done1.note), JSON.stringify(done1));

// the hands-on strip in the fractions lesson
await page.evaluate(() => { state.showLesson = 'fractions'; render(); });
await page.waitForSelector('.lab');
for (let i = 0; i < 3; i++) await page.click('.lab-plus');
for (const i of [0, 2, 3]) await (await page.$$('.lab-cell'))[i].click();   // any 3 parts: the line measures the amount
const labState = () => page.evaluate(() => ({ label: document.querySelector('.lab-label').textContent, dot: document.querySelector('.lab-dot').getBoundingClientRect().x,
  done: document.querySelectorAll('.lab-task.done').length, note: document.querySelector('.lab-note').textContent }));
const lab1 = await labState();
await page.click('.lab-cut');
const lab2 = await labState();
check('the lesson strip: 4 parts with 3 coloured reads 3/4; cutting every part in 2 reads 6/8 at the same place, and all three tasks tick',
  /3 of 4 equal parts/.test(lab1.label) && lab1.done === 2 && /6 of 8 equal parts/.test(lab2.label) && Math.abs(lab1.dot - lab2.dot) < 0.5 &&
  lab2.done === 3 && /same number/.test(lab2.note), JSON.stringify({ lab1, lab2 }));
await page.evaluate(() => { state.showLesson = null; localStorage.clear(); });

console.log('23. word problems that transfer: new story types, twists once a type is solid, the number nobody needs');
await page.evaluate(() => { localStorage.clear(); });
await page.goto(base);
await page.waitForSelector('.ready-start, .qcard');
const wt = await page.evaluate(() => {
  localStorage.clear(); Stats.reset();
  for (let r = 0; r < 8; r++) for (let a = 2; a <= 12; a++) for (let b = a; b <= 12; b++) Stats.recordMul(a, b, true, 2000);
  Stats.checkUnlocks();
  const learning = Array.from({ length: 300 }, () => genWord()).filter(q => q.xf).length;
  for (const k of ['wjoin', 'wcompare', 'wgroups', 'wshare']) for (let i = 0; i < 6; i++) { Stats.recordSkill('word', true, 9000); Stats.recordSkill('word.' + k, true, 9000); }
  const vars = new Set(), xfs = {}, bad = [];
  let twisted = 0;
  for (let i = 0; i < 2000; i++) {
    const q = genWord();
    vars.add(q.wvar);
    if (q.xf) { xfs[q.xf] = (xfs[q.xf] || 0) + 1; twisted++; }
    const [x, sym, y] = q.op.split(' ');
    if (wCalc(+x, sym, +y) !== q.ans || q.trap === q.ans || !Number.isInteger(q.ans) || q.ans <= 0) bad.push('key: ' + q.text);
    if (/undefined|NaN/.test(q.text)) bad.push('text: ' + q.text);
    if (q.xf === 'qfirst' && !/^How /.test(q.text)) bad.push('question not first: ' + q.text);
    if (q.xf === 'extra') {
      if (!q.text.includes(String(q.extra))) bad.push('the extra number is missing: ' + q.text);
      if (q.extraVals.includes(q.ans) || q.extraVals.includes(q.trap)) bad.push('the extra number overlaps the key: ' + q.text);
      for (const v of q.extraVals) if (wordMiss(q, v) !== 'extra') bad.push('using the extra number is not diagnosed: ' + q.text);
    }
    if (q.xf === 'table' && !(q.tbl && q.tbl.rows.length === 2 && q.text.endsWith(q.tbl.ask))) bad.push('table: ' + q.text);
  }
  return { learning, vars: [...vars].sort().join(','), xfs, share: twisted / 2000, bad: bad.slice(0, 3), badCount: bad.length };
});
check('no twists while a story type is still being learned', wt.learning === 0, 'twisted=' + wt.learning);
check('new story types: take away, start unknown, two parts, the difference, "times as many" that divides',
  ['sep', 'startjoin', 'total', 'diff', 'timesdiv'].every(v => wt.vars.split(',').includes(v)), wt.vars);
check('once solid, about half the stories get a twist: a number not needed, the question first, or a table',
  wt.share > 0.4 && wt.share < 0.6 && wt.xfs.extra > 0 && wt.xfs.qfirst > 0 && wt.xfs.table > 0, `${wt.share} ${JSON.stringify(wt.xfs)}`);
check('2000 stories: keys right, twists well formed, every use of the unneeded number diagnosed', wt.badCount === 0, wt.bad.join('; '));
await page.evaluate(() => {
  startWordPractice();
  let q, t;
  do q = genWord('wjoin'); while (q.xf !== 'extra' || !q.extraVals.length);
  do t = genWord(); while (t.xf !== 'table');
  state.quiz[0] = { ...q, id: 0, given: '' };
  state.quiz[1] = { ...t, id: 1, given: '' };
  render();
});
const tCard = await page.evaluate(() => {
  const c = document.querySelectorAll('.qcard')[1];
  return { rows: c.querySelectorAll('.wtable tr').length, ask: (c.querySelector('.wstory-q') || {}).textContent, want: state.quiz[1].tbl.ask };
});
check('a table story draws its table, then the question', tCard.rows === 2 && tCard.ask === tCard.want, JSON.stringify(tCard));
const xv = await page.evaluate(() => state.quiz[0].extraVals[0]);
const xb = await (await page.$$('.qcard'))[0].$('input');
await xb.fill(String(xv)); await xb.press('Enter');
await page.waitForTimeout(150);
const xh = await page.evaluate(() => ({ pill: document.querySelector('.qcard .fixpill').textContent, extra: state.quiz[0].extra, err: errEntry(state.quiz[0]) }));
check('practice: using the number nobody needs is named, without the answer', xh.pill.includes(`That uses ${xh.extra}`) && /another go/.test(xh.pill), xh.pill);
check('…and logged as such, with its twist', xh.err.extra === true && xh.err.xf === 'extra', JSON.stringify(xh.err));
const wx = await page.evaluate(() => {
  state.quiz = [state.quiz[0]];
  submit(false);
  const f = Stats.getSkill('wordx') || {};
  return { right: f.right || 0, wrong: f.wrong || 0 };
});
check('stories with a twist are tracked on their own', wx.right === 0 && wx.wrong === 1, JSON.stringify(wx));
const twLine = await page.evaluate(() => {
  Stats.recordSkill('wordx', true, 9000);
  state.showStats = true; render();
  const t = [...document.querySelectorAll('.stats-line')].map(e => e.textContent).find(x => /With a twist/.test(x)) || '';
  state.showStats = false; render();
  return t;
});
check('the parent panel shows how stories with a twist go', /With a twist .*: 50% of 2/.test(twLine), twLine);
const wPat = await page.evaluate(() => {
  Stats.recordError({ d: Date.now() + 5, k: 'word.wjoin', g: '50', ans: '30', extra: true });
  Stats.recordError({ d: Date.now() + 6, k: 'word.wjoin', g: '51', ans: '31', extra: true });
  return Stats.errorPatterns().filter(p => p.key === 'word.wjoin').map(p => p.kind + ': ' + p.label)[0] || '';
});
check('using numbers the question does not need becomes a named pattern for the parent', /^misconception: .*numbers the question does not need/.test(wPat), wPat);

console.log('24. subtraction: trading across a 0 in words, the across-0 bug named, answers checked backwards');
const sb = await page.evaluate(() => {
  const strip = h => h.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '');
  const steps = {};
  for (const [a, b] of [[503, 278], [742, 318], [900, 456], [654, 321]]) steps[`${a}-${b}`] = strip(buildSubWork(a, b));
  const q = { type: 'sub', a: 503, b: 278, ans: 225 };
  const d = {};
  for (const g of ['335', '325', '235', '375']) d[g] = diagnose(q, g);
  localStorage.clear(); Stats.reset();
  for (const g of ['335', '325']) Stats.recordError({ ...errEntry({ ...q, bucket: 'sub:2', given: g }), d: Date.now() + Number(g) });
  return { steps, d, add: diagnose({ type: 'add', a: 368, b: 275, ans: 643 }, '533'),
           zero: errEntry({ ...q, given: '335' }).zero, plain: errEntry({ type: 'sub', a: 742, b: 318, ans: 424, given: '434', bucket: 'sub:1' }),
           pat: Stats.errorPatterns().filter(p => p.key === 'sub:2').map(p => p.kind + ': ' + p.label)[0] || '' };
});
check('503 − 278 is worked in words: no tens to trade from, so a hundred first; the 0 becomes 9, never "-1"',
  /There are 0 tens, so trade 1 hundred for 10 tens first, then 1 ten for 10 ones → 13 − 8 = 5/.test(sb.steps['503-278']) &&
  /9 − 7 = 2/.test(sb.steps['503-278']) && /Hundreds: after the trade, 4\. 4 − 2 = 2/.test(sb.steps['503-278']) &&
  !Object.values(sb.steps).some(t => /-1|−1\b/.test(t)), sb.steps['503-278'].split('\n').slice(-4).join(' | '));
check('a plain trade says regroup; no trade, no trade words', /Regroup: trade 1 ten for 10 ones → 12 − 8 = 4/.test(sb.steps['742-318']) &&
  /0 can't take 6/.test(sb.steps['900-456']) && !/trade/i.test(sb.steps['654-321']));
check('the across-0 answers (off by 10, 100 or 110) are named as the 0 with nothing to trade', ['335', '325', '235'].every(g => /nothing to trade/.test(sb.d[g].why)));
check('every subtraction tip starts with the backwards check from the child\'s own answer, and so does addition',
  /^Check it backwards: 335 \+ 278 = 613, not 503\./.test(sb.d['335'].tip) && /bigger-minus-smaller/.test(sb.d['375'].why) &&
  /^Check it backwards: 533 − 275 = 258, not 368\./.test(sb.add.tip) && /ones and tens columns went over 10/.test(sb.add.why), sb.d['335'].tip);
check('the across-0 slip is logged; an ordinary tens slip is not', sb.zero === true && sb.plain.zero === false && sb.plain.ten === true);
check('two of them become a named pattern for the parent', /^misconception: Subtraction across a 0/.test(sb.pat), sb.pat);

console.log('25. the warm-up keeps every strand alive: a division fact and the weakest story already met');
await page.evaluate(() => { localStorage.clear(); });
await page.goto(base);
await page.waitForSelector('.ready-start, .qcard');
const wu = await page.evaluate(() => {
  localStorage.clear(); Stats.reset();
  for (let r = 0; r < 8; r++) for (let a = 2; a <= 12; a++) for (let b = a; b <= 12; b++) Stats.recordMul(a, b, true, 2000);
  Stats.checkUnlocks();
  for (let r = 0; r < 4; r++) for (let b = 2; b <= 12; b++) for (let c = b; c <= 12; c++) Stats.recordDiv(b, c, true, 3000);
  const none = focusQuiz(true).filter(q => q.type === 'word' || q.type === 'geo').length;   // no story met yet
  for (const k of ['wjoin', 'wcompare', 'wgroups']) for (let i = 0; i < 6; i++) Stats.recordSkill('word.' + k, true, 9000);
  for (let i = 0; i < 3; i++) Stats.recordSkill('word.wshare', false, 9000);
  const runs = Array.from({ length: 40 }, () => focusQuiz(true));
  return {
    none, lens: [...new Set(runs.map(r => r.length))].sort().join(','),
    div: runs.every(r => r.filter(q => q.type === 'div').length === 1),
    share: runs.every(r => r.filter(q => q.type === 'word').length === 1 && r.some(q => q.type === 'word' && q.wkind === 'wshare')),
    geo: runs.some(r => r.some(q => q.type === 'geo')),
    frac: runs.every(r => r.some(q => isFracQ(q))),
    addsub: runs.every(r => r.filter(q => q.type === 'add' || q.type === 'sub').length === 1),
    facts: runs.every(r => r.some(q => q.type === 'mul')),
  };
});
check('stories and shapes not met yet stay out of the warm-up (the quiz introduces them)', wu.none === 0, 'stories=' + wu.none);
check('the warm-up is still 5-6 questions, with at least one times-table fact and one add/subtract', /^[56](,[56])?$/.test(wu.lens) && wu.facts && wu.addsub, wu.lens);
check('…plus one division fact, the most missed story type, and a fraction while fractions are being learned', wu.div && wu.share && !wu.geo && wu.frac, JSON.stringify(wu));

console.log('26. the 1-minute fact sprint: known facts only, misses fixed on the spot, meet or beat your usual');
await page.evaluate(() => { localStorage.clear(); });
await page.goto(base);
await page.waitForSelector('.ready-start, .qcard');
const sp0 = await page.evaluate(() => {
  localStorage.clear(); Stats.reset();
  for (let r = 0; r < 8; r++) for (let b = 2; b <= 12; b++) Stats.recordMul(2, b, true, 2000);
  Stats.markDaily('warmup');
  state.phase = 'ready'; render();
  return { ready: Stats.sprintReady(), chip: [...document.querySelectorAll('.day-chip')].some(c => /Sprint/.test(c.textContent)), label: nextStepLabel() };
});
check('no sprint before 20 facts are solid: the warm-up leads straight to the quiz', !sp0.ready && !sp0.chip && /Today's quiz/.test(sp0.label), JSON.stringify(sp0));
const sp1 = await page.evaluate(() => {
  for (let r = 0; r < 8; r++) for (let a = 3; a <= 5; a++) for (let b = a; b <= 12; b++) Stats.recordMul(a, b, true, a === 5 ? 6000 : 2000);
  const pool = Stats.sprintPool(), solid = Stats.mulFluentCount();
  render();
  return { ready: Stats.sprintReady(), n: pool.length, solid, ops: [...new Set(pool.map(p => p.op))].join(''),
           slow: pool.filter(p => p.w === 3).map(p => p.a + 'x' + p.b).join(','),
           chips: [...document.querySelectorAll('.day-chip')].map(c => c.textContent).join(' → '),
           active: (document.querySelector('.day-chip.active') || {}).textContent, start: document.querySelector('.ready-start').textContent };
});
check('from 20 solid facts the day gains a sprint after the warm-up', sp1.ready && sp1.chips === '✓ 🎯 Warm-up → ⚡ Sprint → 📝 Quiz' && sp1.active === '⚡ Sprint' && /1-minute sprint/.test(sp1.start), JSON.stringify(sp1));
check('it draws on solid facts only, the slow ones three times as often', sp1.n === sp1.solid && sp1.ops === '×' && /^5x5(,5x\d+)+$/.test(sp1.slow), JSON.stringify(sp1));
await page.click('.ready-start');
await page.waitForSelector('.sprint-go');
const sIntro = await page.evaluate(() => ({ phase: state.phase, goal: document.querySelector('.sprint-goal').textContent, chart: !!document.querySelector('.sprint-chart'), timer: !!sprint.timer }));
check('the sprint opens on an intro with the clock stopped; the first one sets the goal', sIntro.phase === 'sprint' && !sIntro.timer && /first sprint sets your goal/.test(sIntro.goal) && !sIntro.chart, JSON.stringify(sIntro));
await page.click('.sprint-go');
await page.waitForTimeout(100);
// Two facts make the order known: they take turns.
await page.evaluate(() => { sprint.pool = [{ op: '×', a: 3, b: 7, w: 1 }, { op: '×', a: 4, b: 8, w: 1 }]; sprint.card = sprintCard(null); sprintPaint(document); });
const spBefore = await page.evaluate(() => { const r = Stats.exportRaw(); return { f37: { ...r.facts['3x7'] }, f48: { ...r.facts['4x8'] } }; });
const seq = [];
for (let i = 0; i < 3; i++) {
  const c = await page.evaluate(() => ({ ...sprint.card }));
  seq.push(`${c.fa}x${c.fb}`);
  await page.type('.sprint-box', String(c.ans));
}
const run1 = await page.evaluate(() => ({ right: sprint.right, score: document.querySelector('.sprint-score').textContent, box: document.querySelector('.sprint-box').value,
                                          focused: document.activeElement === document.querySelector('.sprint-box') }));
check('typing the answer moves straight on to the next fact, in the same box, never the same fact twice running',
  run1.right === 3 && run1.score === '✓ 3' && run1.box === '' && run1.focused && seq[0] !== seq[1] && seq[2] === seq[0], JSON.stringify(run1) + ' ' + seq.join(','));
const mc = await page.evaluate(() => ({ ...sprint.card }));
const wrongAns = String(mc.ans + 1);
await page.type('.sprint-box', wrongAns);
const miss = await page.evaluate(() => ({ wrong: sprint.wrong, note: document.querySelector('.sprint-note').textContent, on: document.querySelector('.sprint-note').classList.contains('on'),
                                          err: Stats.getErrlog().slice(-1)[0] || {}, same: sprint.card.fa + 'x' + sprint.card.fb }));
check('a wrong answer shows the fact with its answer to type before moving on, and is logged as a sprint miss',
  miss.wrong === 1 && miss.on && miss.note.includes(`= ${mc.ans} — type ${mc.ans}`) && miss.same === `${mc.fa}x${mc.fb}` &&
  miss.err.sp === 1 && miss.err.g === wrongAns && miss.err.ans === String(mc.ans), JSON.stringify(miss));
await page.type('.sprint-box', String(mc.ans));
const spAfter = await page.evaluate(() => ({ right: sprint.right, miss: sprint.miss, note: document.querySelector('.sprint-note').textContent }));
check('…copying it moves on without a point', spAfter.right === 3 && !spAfter.miss && spAfter.note === '', JSON.stringify(spAfter));
const ec = await page.evaluate(() => ({ ...sprint.card }));
await page.type('.sprint-box', '9');
await page.press('.sprint-box', 'Enter');
const ent = await page.evaluate(() => ({ wrong: sprint.wrong, miss: sprint.miss, right: sprint.right }));
check('Enter on a short wrong answer counts as a miss too', ent.wrong === 2 && ent.miss && ent.right === 3, JSON.stringify(ent));
await page.type('.sprint-box', String(ec.ans));
await page.evaluate(() => { sprint.endsAt = Date.now() - 1; sprintTick(); });
await page.waitForTimeout(150);
const spDone = await page.evaluate(() => {
  const r = Stats.exportRaw();
  return { stage: sprint.stage, right: sprint.right, title: document.querySelector('.ready-title').textContent, goal: document.querySelector('.sprint-goal').textContent,
           bars: document.querySelectorAll('.sprint-chart .spr-bar').length, now: document.querySelectorAll('.sprint-chart .spr-bar.now').length,
           misses: (document.querySelector('.sprint-miss') || {}).textContent || '', sprints: r.sprints, daily: Stats.getDaily(),
           f37: r.facts['3x7'], f48: r.facts['4x8'], next: [...document.querySelectorAll('.sprint-actions button')].map(b => b.textContent) };
});
check('when the minute is up: the score, the goal it sets, a chart, and the misses to practise',
  spDone.stage === 'done' && spDone.title === '3 right in one minute!' && /goal to meet or beat/.test(spDone.goal) && spDone.bars === 1 && spDone.now === 1 &&
  /^To practise: \d+ × \d+ = \d+ · \d+ × \d+ = \d+$/.test(spDone.misses), JSON.stringify({ ...spDone, sprints: undefined, f37: undefined, f48: undefined }));
const dd = k => ({ right: spDone[k].right - (spBefore[k].right || 0), wrong: spDone[k].wrong - (spBefore[k].wrong || 0) });
check('each fact feeds its memory once per sprint, a miss always: the repeat right answer adds to the score, not to the fact',
  ['f37', 'f48'].every(k => dd(k).right === 1 && dd(k).wrong === 1), JSON.stringify({ f37: dd('f37'), f48: dd('f48') }));
check('the sprint is saved with its misses, and today\'s sprint is done',
  spDone.sprints.length === 1 && spDone.sprints[0].n === 3 && spDone.sprints[0].w === 2 && spDone.daily.sprint === true, JSON.stringify(spDone.sprints));
check('it offers another go, or on to today\'s quiz', spDone.next.join('|') === "⚡ Again|▶ Today's quiz", spDone.next.join('|'));
const sync = await page.evaluate(() => {
  const t = Date.now() + 60000;
  const remote = { sprints: [{ d: t, n: 12, w: 1 }, { d: t + 1, n: 20, w: 0 }, { d: t + 2, n: 15, w: 2 }] };
  Stats.importMerge(remote); Stats.importMerge(remote);
  return { n: Stats.getSprints().length, goal: Stats.sprintGoal(), sum: sprintSummary() };
});
check('sprints from another device merge in once; the usual is the middle of the last three', sync.n === 4 && sync.goal === 15 && sync.sum.best === 20 && sync.sum.last === 15, JSON.stringify(sync));
await page.click('.sprint-actions button:has-text("Again")');
await page.waitForSelector('.sprint-go');
const intro2 = await page.evaluate(() => ({ goal: document.querySelector('.sprint-goal').textContent, bars: document.querySelectorAll('.sprint-chart .spr-bar').length, line: !!document.querySelector('.sprint-chart .spr-goal') }));
check('another go starts from the usual to meet or beat, drawn on the chart', /Your usual: 15\. Can you meet or beat it\?/.test(intro2.goal) && intro2.bars === 4 && intro2.line, JSON.stringify(intro2));
await page.click('.sprint-go');
await page.waitForTimeout(100);
await page.evaluate(() => { sprint.endsAt = Date.now() - 1; sprintTick(); });
await page.waitForTimeout(100);
const idle = await page.evaluate(() => ({ title: document.querySelector('.ready-title').textContent, n: Stats.getSprints().length }));
check('a minute with no answers is not saved as a score', idle.title === 'No answers this time' && idle.n === 4, JSON.stringify(idle));
await page.click(`.sprint-actions button:has-text("Today's quiz")`);
await page.waitForTimeout(300);
const q2 = await page.evaluate(() => ({ phase: state.phase, step: state.dailyStep, len: state.quiz.length, imm: state.immediate,
                                        chips: [...document.querySelectorAll('.day-chip')].map(c => c.textContent).join(' → ') }));
check('then on to today\'s quiz, with the sprint ticked off', q2.phase === 'quiz' && q2.step === 'quiz' && q2.len === 10 && !q2.imm && q2.chips === '✓ 🎯 Warm-up → ✓ ⚡ Sprint → 📝 Quiz', JSON.stringify(q2));
const spLine = await page.evaluate(() => {
  state.showStats = true; render();
  const t = [...document.querySelectorAll('.stats-line')].map(e => e.textContent).find(x => /1-minute sprint/.test(x)) || '';
  state.showStats = false; render();
  const mk = Stats.getDaily();
  Stats.importMerge({ daily: { day: mk.day, warmup: true, quiz: true, sprint: false } });
  return { t, kept: Stats.getDaily().sprint };
});
check('the parent panel shows the sprints; a device that has not sprinted today cannot untick it',
  /⚡ 1-minute sprint: 4 done · last 15 right · usual 15 · best 20/.test(spLine.t) && spLine.kept === true, JSON.stringify(spLine));

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
