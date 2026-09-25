// Kid-facing mini-lesson for one problem, via Tencent Hunyuan
// (OpenAI-compatible Chat Completions API).
import { checkLimit } from './_ratelimit.js';
export const config = { maxDuration: 30 };

const BASE_URL = process.env.HUNYUAN_BASE_URL || 'https://api.hunyuan.cloud.tencent.com/v1';
const MODEL = process.env.HUNYUAN_MODEL || 'hunyuan-turbo';

const SYSTEM_PROMPT = `You are a fun, patient math tutor for a child around 8 years old. The child just got ONE problem wrong and tapped "Teach me this".

Explain how to work out THIS specific problem in 2-4 short sentences, using simple words a young child understands and one memorable trick or strategy (e.g. skip-counting, doubling, the ×9 finger trick, "make a ten", splitting a number). Be warm and encouraging. End with the correct answer.

Rules:
- Plain English, no markdown headings, no bullet lists, no code blocks. Just a few short sentences.
- Keep it tiny — it shows in a small box on a tablet.
- Don't lecture; make it feel easy and fun.`;

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function validProblem(p) {
  if (!p || typeof p.type !== 'string') return false;
  if (['mul', 'add', 'sub', 'div'].includes(p.type)) return isNum(p.a) && isNum(p.b);
  if (p.type === 'mul2') return isNum(p.a) && isNum(p.b) && p.a >= 10 && p.a < 100 && p.b >= 10 && p.b < 100;
  if (p.type === 'fnam') return isNum(p.shaded) && isNum(p.den);
  if (p.type === 'feq') return isNum(p.n1) && isNum(p.d1) && isNum(p.d2) && isNum(p.ans);
  if (p.type === 'fcmp') return isNum(p.n1) && isNum(p.d1) && isNum(p.n2) && isNum(p.d2) && typeof p.ans === 'string';
  // Must be a real division, or the model would be told a wrong answer.
  if (p.type === 'ldiv') return isNum(p.a) && isNum(p.b) && isNum(p.q) && isNum(p.r) && p.b > 0 && p.a < 10000 &&
                                p.r >= 0 && p.r < p.b && p.b * p.q + p.r === p.a;
  // Word problems carry their own story; bounded so the endpoint cannot be
  // used as a general-purpose prompt.
  if (p.type === 'geo') return typeof p.text === 'string' && p.text.length > 0 && p.text.length <= 200 && isNum(p.ans) &&
                               Array.isArray(p.steps) && p.steps.length >= 1 && p.steps.length <= 3 &&
                               p.steps.every(t => typeof t === 'string' && t.length > 0 && t.length <= 160);
  // Two-step problems add their steps, bounded the same way.
  if (p.type === 'word') return typeof p.text === 'string' && p.text.length > 0 && p.text.length <= 400 &&
                                typeof p.op === 'string' && p.op.length <= 40 && isNum(p.ans) &&
                                (p.steps === undefined || (Array.isArray(p.steps) && p.steps.length >= 1 && p.steps.length <= 3 &&
                                  p.steps.every(t => typeof t === 'string' && t.length > 0 && t.length <= 120)));
  return false;
}
function describe(p) {
  const a = p.a, b = p.b;
  if (p.type === 'mul2') {
    const at = a - a % 10, bt = b - b % 10;
    return `${a} × ${b} (the answer is ${a * b}), best done with the area model: split ${a} into ${at} + ${a % 10} and ${b} into ${bt} + ${b % 10}, ` +
      `multiply every part by every part (four products) and add them. Children often multiply only tens × tens and ones × ones, ` +
      'or forget that the tens digit is worth ten, so make the four boxes vivid';
  }
  if (p.type === 'mul') return `${a} × ${b} (the answer is ${a * b})`;
  if (p.type === 'add') return `${a} + ${b} (the answer is ${a + b})`;
  if (p.type === 'sub') return `${a} − ${b} (the answer is ${a - b})`;
  if (p.type === 'div') return `${a} ÷ ${b} (the answer is ${a / b}); it helps to remember ${b} × ${a / b} = ${a}`;
  if (p.type === 'fnam') return `naming the fraction shown by a bar split into ${p.den} equal parts with ${p.shaded} shaded — the answer is the fraction ${p.shaded}/${p.den}`;
  if (p.type === 'feq') return `finding the missing top number so the fractions are equal: ${p.n1}/${p.d1} = ?/${p.d2} — the answer is ${p.ans}, because you multiply top and bottom by ${p.d2 / p.d1}`;
  if (p.type === 'ldiv') {
    return `${p.a} ÷ ${p.b} with a remainder — the answer is ${p.q} remainder ${p.r}, because ${p.b} × ${p.q} = ${p.b * p.q} and ` +
      `${p.a} − ${p.b * p.q} = ${p.r}. The remainder is always smaller than ${p.b}; for bigger numbers use divide, multiply, subtract, bring down, ` +
      'and write a 0 in the answer whenever the divisor does not fit';
  }
  if (p.type === 'geo') {
    return `an area / perimeter problem: "${p.text}" — the working is: ${p.steps.join('; ')}; the answer is ${p.ans}. ` +
      'Children at this age often mix up area (the unit squares covering the inside, in square units) and perimeter ' +
      '(the distance around the edge, in units), so make that difference vivid, for example by counting squares versus walking around the edge';
  }
  if (p.type === 'word' && p.steps) {
    const story = p.text.replace(/\s+/g, ' ').trim();
    return `a two-step word problem: "${story}" — the steps are: ${p.steps.map((t, i) => `(${i + 1}) ${t}`).join(' ')}; the answer is ${p.ans}. ` +
      'The real skill is noticing the hidden number that must be found first, then checking that the final answer is what the question asks for — ' +
      'children often stop after the first step. If there is a remainder, explain how the question decides what to do with it';
  }
  if (p.type === 'word') {
    const story = p.text.replace(/\s+/g, ' ').trim();
    return `a word problem: "${story}" — the right plan is ${p.op} = ${p.ans}. ` +
      'The real skill here is working out from the story whether it asks for a total, a difference, or a share — ' +
      'words like "more" or "gave away" can point to the wrong operation, so explain how the story itself tells you which one to use';
  }
  if (p.type === 'fcmp') return `comparing two fractions ${p.n1}/${p.d1} and ${p.n2}/${p.d2} using <, =, or > — the correct comparison is ${p.n1}/${p.d1} ${p.ans} ${p.n2}/${p.d2}`;
  return 'this problem';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!process.env.HUNYUAN_API_KEY) { res.status(500).json({ error: 'Server is missing HUNYUAN_API_KEY' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const p = body && body.problem;
  if (!validProblem(p)) {
    res.status(400).json({ error: 'Missing or invalid problem' });
    return;
  }

  // Checked after validation, so malformed requests never count against the
  // family's allowance, and before the paid model call.
  const limited = await checkLimit('teach', req);
  if (limited) { res.status(limited.status).json(limited.body); return; }

  try {
    const resp = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.HUNYUAN_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        temperature: 0.8,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Teach me how to do ${describe(p)}.` },
        ],
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      res.status(resp.status).json({ error: `Model error (${resp.status}): ${text.slice(0, 200)}` });
      return;
    }
    const data = await resp.json();
    const lesson = data?.choices?.[0]?.message?.content?.trim();
    if (!lesson) { res.status(502).json({ error: 'No content returned' }); return; }
    res.status(200).json({ lesson });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'Teach failed' });
  }
}
