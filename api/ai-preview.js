import { requireDashboardAuth } from '../lib/auth.js';
import { fetchMarketScan, fetchBarsForSymbols } from '../lib/strategy.js';
import { getAiTradeDecision } from '../lib/ai.js';
import { buildCandidateContext } from '../lib/context.js';
import { evaluateEntry, entryThresholdForRegime, maxPortfolioCorrelation } from '../lib/risk.js';

export default async function handler(req, res) {
  if (!requireDashboardAuth(req, res)) return;
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

    const [account, positionsRaw] = await Promise.all([accountRes.json(), positionsRes.json()]);
    if (!accountRes.ok || !positionsRes.ok) {
      return res.status(502).json({ error: 'Could not load Alpaca context for AI' });
    }

    const positions = Array.isArray(positionsRaw) ? positionsRaw : [];
    const scan = await fetchMarketScan(alpacaKey, alpacaSecret);
    const threshold = entryThresholdForRegime(scan.regime?.label);
    const eligible = scan.candidates.filter(c => c.score >= Math.max(68, threshold - 10)).slice(0, 5);
    const candidateContext = await buildCandidateContext(eligible, alpacaKey, alpacaSecret);

    if (!eligible.length) {
      return res.status(200).json({
        source: 'QUANT_FALLBACK',
        model: 'quant-fallback-v2',
        regime: scan.regime,
        decision: {
          action: 'SKIP',
          symbol: '',
          confidence: 100,
          rationale: 'No market-wide scanner candidates met the minimum review threshold.'
        },
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
          positions,
          account,
          marketContext: scan.regime,
          candidateContext
        });
        source = 'LLM';
      } catch (error) {
        llm_error = String(error?.message || 'Gemini request failed').slice(0, 400);
      }
    } else {
      llm_error = 'GEMINI_API_KEY is not configured.';
    }

    if (!decision) {
      const best = eligible[0];
      decision = best && best.score >= threshold
        ? {
            action: 'BUY',
            symbol: best.symbol,
            confidence: Math.min(95, Math.max(60, best.score)),
            rationale: 'Gemini is unavailable, so the quantitative fallback selected the highest-scoring candidate that passed the regime-adjusted threshold.'
          }
        : {
            action: 'SKIP',
            symbol: '',
            confidence: 80,
            rationale: 'Gemini is unavailable and no candidate passed the regime-adjusted quantitative entry threshold.'
          };
    }

    const pick = decision.action === 'BUY'
      ? eligible.find(c => c.symbol === decision.symbol)
      : null;

    let portfolioCorrelation = null;
    if (pick && positions.length) {
      const symbols = [...new Set([pick.symbol, ...positions.map(p => p.symbol)])];
      const correlationBars = await fetchBarsForSymbols(symbols, alpacaKey, alpacaSecret, 100);
      const heldBars = Object.fromEntries(
        positions.map(p => [p.symbol, correlationBars[p.symbol] || []])
      );
      portfolioCorrelation = maxPortfolioCorrelation(
        correlationBars[pick.symbol] || [],
        heldBars
      );
    }

    const risk = pick
      ? evaluateEntry({
          account,
          positions,
          candidate: pick,
          regime: scan.regime,
          eventContext: candidateContext[pick.symbol],
          confidence: decision.confidence,
          portfolioCorrelation
        })
      : {
          approved: false,
          reasons: ['No entry selected'],
          threshold,
          portfolio: null,
          sizing: null
        };

    return res.status(200).json({
      source,
      model: source === 'LLM' ? decision.model : 'quant-fallback-v2',
      llm_error,
      regime: scan.regime,
      decision,
      risk,
      candidates: eligible.map(c => ({
        symbol: c.symbol,
        score: c.score,
        atr_pct: c.atr_pct,
        relative_strength_20d: c.relative_strength_20d,
        event_risk: candidateContext[c.symbol]?.risk?.level || 'LOW'
      }))
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'AI analysis failed' });
  }
}
