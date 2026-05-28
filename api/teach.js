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

function describe(p) {
  const a = p.a, b = p.b;
  if (p.type === 'mul') return `${a} × ${b} (the answer is ${a * b})`;
  if (p.type === 'add') return `${a} + ${b} (the answer is ${a + b})`;
  if (p.type === 'sub') return `${a} − ${b} (the answer is ${a - b})`;
  return `${a} ? ${b}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!process.env.HUNYUAN_API_KEY) { res.status(500).json({ error: 'Server is missing HUNYUAN_API_KEY' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const p = body && body.problem;
  if (!p || !['mul', 'add', 'sub'].includes(p.type) || typeof p.a !== 'number' || typeof p.b !== 'number') {
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
