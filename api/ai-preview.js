import { fetchCandidates } from '../lib/strategy.js';
import { getAiTradeDecision } from '../lib/ai.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const alpacaKey = process.env.ALPACA_API_KEY;
  const alpacaSecret = process.env.ALPACA_SECRET_KEY;
  const baseUrl = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!alpacaKey || !alpacaSecret) return res.status(500).json({ error: 'Missing Alpaca credentials' });
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
        model: 'gemini-3.8-flash',
        decision: { action: 'SKIP', symbol: '', confidence: 100, rationale: 'No scanner candidates met the minimum review threshold.' },
        candidates: []
      });
    }

    let decision;
    let source = 'QUANT_FALLBACK';
    let llm_error = null;

    if (geminiKey) {
      try {
        decision = await getAiTradeDecision({
          apiKey: geminiKey,
          candidates: eligible,
          positions: Array.isArray(positions) ? positions : [],
          account
        });
        source = 'LLM';
      } catch (error) {
        llm_error = String(error?.message || 'Gemini request failed').slice(0, 300);
      }
    } else {
      llm_error = 'GEMINI_API_KEY is not configured.';
    }

    if (!decision) {
      const best = eligible[0];
      decision = best && best.score >= 78
        ? {
            action: 'BUY',
            symbol: best.symbol,
            confidence: Math.min(95, Math.max(60, best.score)),
            rationale: 'Gemini is unavailable, so the quantitative fallback selected the highest-scoring candidate that passed the hard entry threshold.'
          }
        : {
            action: 'SKIP',
            symbol: '',
            confidence: 80,
            rationale: 'Gemini is unavailable and no candidate passed the hard quantitative entry threshold.'
          };
    }

    return res.status(200).json({
      source,
      model: source === 'LLM' ? decision.model : 'quant-fallback-v1',
      llm_error,
      decision,
      candidates: eligible.map(c => ({ symbol: c.symbol, score: c.score }))
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'AI analysis failed' });
  }
}
