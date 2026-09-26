import { fetchCandidates } from '../lib/strategy.js';
import { getAiTradeDecision } from '../lib/ai.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const alpacaKey = process.env.ALPACA_API_KEY;
  const alpacaSecret = process.env.ALPACA_SECRET_KEY;
  const baseUrl = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!alpacaKey || !alpacaSecret) return res.status(500).json({ error: 'Missing Alpaca credentials' });
  if (!openaiKey) return res.status(503).json({ error: 'Add OPENAI_API_KEY in Vercel to activate the LLM decision layer.' });
  if (!baseUrl.includes('paper-api.alpaca.markets')) {
    return res.status(403).json({ error: 'AI preview is paper-only.' });
  }

  const headers = {
    'APCA-API-KEY-ID': alpacaKey,
    'APCA-API-SECRET-KEY': alpacaSecret
  };

  try {
    const [accountRes, positionsRes] = await Promise.all([
      fetch(`${baseUrl}/v2/account`, { headers }),
      fetch(`${baseUrl}/v2/positions`, { headers })
    ]);

    const [account, positions] = await Promise.all([accountRes.json(), positionsRes.json()]);
    if (!accountRes.ok || !positionsRes.ok) {
      return res.status(502).json({ error: 'Could not load Alpaca context for AI' });
    }

    const candidates = await fetchCandidates(alpacaKey, alpacaSecret);
    const eligible = candidates.filter(c => c.score >= 66).slice(0, 5);

    if (!eligible.length) {
      return res.status(200).json({
        model: 'gpt-5.6-luna',
        decision: { action: 'SKIP', symbol: '', confidence: 100, rationale: 'No scanner candidates met the minimum review threshold.' },
        candidates: []
      });
    }

    const decision = await getAiTradeDecision({
      apiKey: openaiKey,
      candidates: eligible,
      positions: Array.isArray(positions) ? positions : [],
      account
    });

    return res.status(200).json({
      model: decision.model,
      decision,
      candidates: eligible.map(c => ({ symbol: c.symbol, score: c.score }))
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'AI analysis failed' });
  }
}
