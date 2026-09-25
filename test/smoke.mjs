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
const fix = await page.$eval('.fixpill', e => e.textContent);
check('practice mode: stopping early is named, then both steps are shown', /one more step/.test(fix) && /Step 1: 30 \+ 12 = 42/.test(fix) && /Step 2: 30 \+ 42 = 72/.test(fix), fix.slice(0, 80));
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
check('L-shapes and missing sides wait until area and perimeter are solid', geo.kinds0 === 'area,perim' && geo.kinds1 === 'area,perim,lshape,missing', `${geo.kinds0} → ${geo.kinds1}`);
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
  const at2 = Stats.checkUnlocks();
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
  return { before, at1, at2, after, bad: bad.slice(0, 3), badCount: bad.length,
           practice: fractionQuiz().filter(q => q.type === 'fadd' || q.type === 'fline').length };
});
check('adding and the number line open once 2 of the 3 basics are solid', fr.before === 'fcmp,feq,fnam' && !fr.at1 && fr.at2 === 'fracops' && fr.after === 'fadd,fcmp,feq,fline,fnam', JSON.stringify(fr));
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
  } else if (q.type === 'fcmp') await (await card.$(`.fcmp-btn:text-is("${q.ans}")`)).click();
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
