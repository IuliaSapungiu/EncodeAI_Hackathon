const express = require('express');
const router = express.Router();

router.post('/cohere-query', async (req, res) => {
  const { prompt } = req.body;
  const key = process.env.COHERE_API_KEY || '';

  if (!key) return res.status(500).json({ error: 'COHERE_API_KEY not set in .env' });
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  try {
    const t0 = Date.now();
    const response = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'command-r-08-2024',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024,
      }),
      signal: AbortSignal.timeout(90000),
    });

    const json = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: json?.message || JSON.stringify(json) });
    }

    const text = json?.message?.content?.[0]?.text ?? '';
    res.json({ text, latency: Date.now() - t0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
