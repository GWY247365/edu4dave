import Anthropic from '@anthropic-ai/sdk';

// Allow up to 60s — Opus with adaptive thinking can take a while.
export const config = { maxDuration: 60 };

const MODEL = process.env.PLAN_MODEL || 'claude-opus-4-7';
const EFFORT = process.env.PLAN_EFFORT || 'medium';

// Stable instructions — cached as a prompt prefix. The volatile per-child
// stats go in the user message, after this cached block.
const SYSTEM_PROMPT = `You are "数学小教练", a warm, encouraging elementary-school math coach. You analyze a child's practice statistics and write a short weekly report plus a next-week plan for the child's PARENT (a dad).

The child practices three things in an iPad quiz app:
- Multiplication facts up to 12×12 (spaced repetition surfaces missed facts more often).
- 3-digit addition, classified by number of carries needed (0, 1, or 2).
- 3-digit subtraction, classified by number of borrows needed (0, 1, or 2).

You receive a JSON object with the child's recent stats: quizzes completed, overall multiplication accuracy, number of mastered facts, daily streak, the weakest multiplication facts (with correct/wrong counts), addition accuracy per carry-bucket, subtraction accuracy per borrow-bucket, and recent quiz scores.

Write your entire response in Simplified Chinese, addressed warmly to the dad (称呼"爸爸"). Use Markdown with exactly these sections:

## 📊 本周表现
2-3 sentences summarizing overall progress — quizzes done, accuracy, streak. Specific and positive.

## 💪 已经掌握得不错
Concrete strengths drawn from the data (high-accuracy buckets, mastered facts, a good streak).

## 🎯 需要加强
List 2-4 specific weak spots from the data: name the exact multiplication facts (e.g. 7×8) and the exact add/sub difficulty buckets (e.g. 两次借位的减法). For each, one short phrase on the likely difficulty.

## 📅 下周练习计划
A concrete, item-by-item plan targeting those weak spots: which facts to drill, which problem types to practice, roughly how many minutes per day. Note that the app already makes weak items appear more often, so the main job is steady daily practice.

## 👨‍👧 给爸爸的小贴士
1-2 practical, encouraging coaching tips — how to help without pressure, how to praise effort, a quick game idea.

Rules:
- Base everything ONLY on the provided data. Never invent facts or numbers not present in the JSON.
- If there is very little data (e.g. fewer than 3 quizzes), say so gently and suggest doing a few more quizzes first, then give a light general plan.
- Keep it concise — a parent should read it in under a minute.
- Be warm and confidence-building.
- Do not echo the raw JSON or include code blocks in your response.`;

const client = new Anthropic();

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const stats = body && body.stats;
  if (!stats) {
    res.status(400).json({ error: 'Missing stats in request body' });
    return;
  }

  try {
    const params = {
      model: MODEL,
      max_tokens: 6000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `这是我儿子最近的数学练习数据（JSON）。请据此生成本周分析和下周计划。\n\n\`\`\`json\n${JSON.stringify(stats, null, 2)}\n\`\`\``,
      }],
    };
    // Adaptive thinking + effort are supported on Opus 4.6/4.7 and Sonnet 4.6.
    // Skip them if the model is overridden to one that would reject them (e.g. Haiku).
    if (/opus-4-7|opus-4-6|sonnet-4-6/.test(MODEL)) {
      params.thinking = { type: 'adaptive' };
      params.output_config = { effort: EFFORT };
    }

    const message = await client.messages.create(params);
    const plan = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    res.status(200).json({ plan });
  } catch (e) {
    const status = e?.status || 500;
    res.status(status).json({ error: e?.message || 'Plan generation failed' });
  }
}
