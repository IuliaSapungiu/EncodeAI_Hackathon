// compete.js — drop this into backend/ and require it from index.js
// Queries Gemini, Groq (Llama3), and HuggingFace in parallel, then judges with Gemini

const express = require('express');
const router = express.Router();

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const HF_KEY = process.env.HF_API_KEY || '';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function callGemini(prompt) {
  const t0 = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return { text, latency: Date.now() - t0 };
}

async function callGroq(prompt) {
  const t0 = Date.now();
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama3-8b-8192',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content ?? '';
  return { text, latency: Date.now() - t0 };
}

async function callHuggingFace(prompt) {
  const t0 = Date.now();
  const res = await fetch(
    'https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.3',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${HF_KEY}`,
      },
      body: JSON.stringify({
        inputs: `<s>[INST] ${prompt} [/INST]`,
        parameters: { max_new_tokens: 512, return_full_text: false },
      }),
      signal: AbortSignal.timeout(40000),
    }
  );
  const json = await res.json();
  const text = Array.isArray(json) ? (json[0]?.generated_text ?? '') : '';
  return { text, latency: Date.now() - t0 };
}

// ── Judge: ask Gemini to score all three answers ──────────────────────────────

async function judgeAnswers(question, answers) {
  const judgePrompt = `You are an impartial judge evaluating AI responses to a question.

Question: "${question}"

Rate each answer on these 4 criteria (0-25 points each, total 100):
1. Accuracy — Is it factually correct?
2. Completeness — Does it fully address the question?
3. Clarity — Is it well-structured and easy to understand?
4. Conciseness — Is it appropriately brief without being superficial?

Answers to judge:
A) Gemini: ${answers.gemini}
B) Llama3: ${answers.llama3}
C) Mistral: ${answers.mistral}

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "gemini":  { "accuracy": 0, "completeness": 0, "clarity": 0, "conciseness": 0, "reasoning": "one sentence" },
  "llama3":  { "accuracy": 0, "completeness": 0, "clarity": 0, "conciseness": 0, "reasoning": "one sentence" },
  "mistral": { "accuracy": 0, "completeness": 0, "clarity": 0, "conciseness": 0, "reasoning": "one sentence" }
}`;

  try {
    const { text } = await callGemini(judgePrompt);
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    // fallback: equal scores
    const fallback = { accuracy: 15, completeness: 15, clarity: 15, conciseness: 15, reasoning: 'Judge unavailable' };
    return { gemini: fallback, llama3: fallback, mistral: fallback };
  }
}

// ── Route ────────────────────────────────────────────────────────────────────

router.post('/compete', async (req, res) => {
  const { question } = req.body;
  if (!question || question.trim().length < 3) {
    return res.status(400).json({ error: 'Question too short' });
  }

  // Run all three in parallel
  const [geminiRes, groqRes, hfRes] = await Promise.allSettled([
    callGemini(question),
    callGroq(question),
    callHuggingFace(question),
  ]);

  const answers = {
    gemini: geminiRes.status === 'fulfilled' ? geminiRes.value.text : '(error: ' + geminiRes.reason?.message + ')',
    llama3: groqRes.status === 'fulfilled' ? groqRes.value.text : '(error: ' + groqRes.reason?.message + ')',
    mistral: hfRes.status === 'fulfilled' ? hfRes.value.text : '(error: ' + hfRes.reason?.message + ')',
  };

  const latencies = {
    gemini: geminiRes.status === 'fulfilled' ? geminiRes.value.latency : 0,
    llama3: groqRes.status === 'fulfilled' ? groqRes.value.latency : 0,
    mistral: hfRes.status === 'fulfilled' ? hfRes.value.latency : 0,
  };

  // Judge quality scores
  const scores = await judgeAnswers(question, answers);

  // Build leaderboard rows
  const models = ['gemini', 'llama3', 'mistral'];
  const labels = { gemini: 'Gemini 1.5 Flash', llama3: 'Llama 3 (8B)', mistral: 'Mistral 7B' };

  const results = models.map((m) => {
    const s = scores[m] || { accuracy: 0, completeness: 0, clarity: 0, conciseness: 0, reasoning: '' };
    const total = s.accuracy + s.completeness + s.clarity + s.conciseness;
    return {
      model: m,
      label: labels[m],
      answer: answers[m],
      latency_ms: latencies[m],
      scores: s,
      total,
    };
  });

  results.sort((a, b) => b.total - a.total);
  results.forEach((r, i) => (r.rank = i + 1));

  res.json({ question, results });
});

module.exports = router;