// Kid-facing mini-lesson for one problem, via Tencent Hunyuan
// (OpenAI-compatible Chat Completions API).
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
  if (p.type === 'fnam') return isNum(p.shaded) && isNum(p.den);
  if (p.type === 'feq') return isNum(p.n1) && isNum(p.d1) && isNum(p.d2) && isNum(p.ans);
  if (p.type === 'fcmp') return isNum(p.n1) && isNum(p.d1) && isNum(p.n2) && isNum(p.d2) && typeof p.ans === 'string';
  return false;
}
function describe(p) {
  const a = p.a, b = p.b;
  if (p.type === 'mul') return `${a} × ${b} (the answer is ${a * b})`;
  if (p.type === 'add') return `${a} + ${b} (the answer is ${a + b})`;
  if (p.type === 'sub') return `${a} − ${b} (the answer is ${a - b})`;
  if (p.type === 'div') return `${a} ÷ ${b} (the answer is ${a / b}); it helps to remember ${b} × ${a / b} = ${a}`;
  if (p.type === 'fnam') return `naming the fraction shown by a bar split into ${p.den} equal parts with ${p.shaded} shaded — the answer is the fraction ${p.shaded}/${p.den}`;
  if (p.type === 'feq') return `finding the missing top number so the fractions are equal: ${p.n1}/${p.d1} = ?/${p.d2} — the answer is ${p.ans}, because you multiply top and bottom by ${p.d2 / p.d1}`;
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
