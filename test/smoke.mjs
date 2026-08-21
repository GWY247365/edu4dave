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

const server = http.createServer(async (req, res) => {
  try {
    const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const body = await readFile(join(root, path));
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

console.log('1. plain mixed quiz grades');
await page.goto(base);
await page.waitForSelector('.qcard');
await page.waitForTimeout(1500); // let first-install SW settle (it re-renders once)
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
await page.waitForSelector('.qcard');
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
check('typed answer restored', (await page.$$eval('.ansbox', els => els.filter(e => e.value === '42').length)) === 1);

console.log('5. reroll fishing is closed: unanswered questions carry over');
await page.evaluate(() => { localStorage.removeItem('mathquiz.session.v1'); startNew(); });
await page.waitForTimeout(200);
const before = await page.evaluate(() => state.quiz.filter(q => q.type !== 'add' && q.type !== 'sub')
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
const after = await page.evaluate(() => state.quiz.filter(q => q.type !== 'add' && q.type !== 'sub')
  .map(q => `${q.type}:${Math.min(q.a || 0, q.b || 0)}x${Math.max(q.a || 0, q.b || 0)}`));
const unansweredBefore = before.filter(s2 => s2 !== answeredSig);
const survived = unansweredBefore.filter(s2 => after.includes(s2)).length;
check('unanswered questions survive 3 rerolls', survived === unansweredBefore.length,
  `${survived}/${unansweredBefore.length} carried`);
const qlen = await page.evaluate(() => state.quiz.length);
check('quiz stays at 10 questions', qlen === 10, 'len=' + qlen);

check('no page errors across all scenarios', pageErrors.length === 0, pageErrors.join('; '));

await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall smoke tests passed');
process.exit(failures ? 1 : 0);
