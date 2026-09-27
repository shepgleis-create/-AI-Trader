import { requireDashboardAuth } from '../lib/auth.js';
import { fetchMarketScan, fetchBarsForSymbols } from '../lib/strategy.js';
import { getAiTradeDecision } from '../lib/ai.js';
import { buildCandidateContext } from '../lib/context.js';
import { evaluateEntry, entryThresholdForRegime, maxPortfolioCorrelation } from '../lib/risk.js';
import { buildAccountRisk } from '../lib/account-risk.js';

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
    const historyUrl = new URL(`${baseUrl}/v2/account/portfolio/history`);
    historyUrl.searchParams.set('period','1M');
    historyUrl.searchParams.set('timeframe','1D');

    const [accountRes, positionsRes, ordersRes, recentOrdersRes, historyRes] = await Promise.all([
      fetch(`${baseUrl}/v2/account`, { headers }),
      fetch(`${baseUrl}/v2/positions`, { headers }),
      fetch(`${baseUrl}/v2/orders?status=open&limit=100&nested=true`, { headers }),
      fetch(`${baseUrl}/v2/orders?status=all&limit=500&direction=desc&nested=true`, { headers }),
      fetch(historyUrl, { headers })
    ]);

    const [account, positionsRaw, ordersRaw, recentOrdersRaw, historyRaw] = await Promise.all([
      accountRes.json().catch(() => ({})),
      positionsRes.json().catch(() => ([])),
      ordersRes.json().catch(() => ([])),
      recentOrdersRes.json().catch(() => ([])),
      historyRes.json().catch(() => ({}))
    ]);

    const checks = [
      { name: 'account', response: accountRes, body: account },
      { name: 'positions', response: positionsRes, body: positionsRaw },
      { name: 'open_orders', response: ordersRes, body: ordersRaw },
      { name: 'recent_orders', response: recentOrdersRes, body: recentOrdersRaw }
    ].map(x => ({
      name: x.name,
      ok: x.response.ok,
      status: x.response.status,
      message: x.response.ok ? null : String(x.body?.message || x.body?.error || x.response.statusText || 'request failed').slice(0,180)
    }));
    const failed = checks.filter(x => !x.ok);
    if (failed.length) {
      return res.status(502).json({
        error: 'Alpaca AI-context check failed — ' + failed.map(x => `${x.name} HTTP ${x.status}${x.message ? ': ' + x.message : ''}`).join(' · '),
        checks
      });
    }

    const historyAvailable = historyRes.ok;
    const historyWarning = historyAvailable
      ? null
      : `portfolio_history HTTP ${historyRes.status}: ${String(historyRaw?.message || historyRaw?.error || historyRes.statusText || 'request failed').slice(0,180)}`;
    const portfolioHistory = historyAvailable ? historyRaw : {};

    const positions = Array.isArray(positionsRaw) ? positionsRaw : [];
    const openOrders = Array.isArray(ordersRaw) ? ordersRaw : [];
    const recentOrders = Array.isArray(recentOrdersRaw) ? recentOrdersRaw : [];
    const accountRisk = buildAccountRisk({
      account,
      positions,
      openOrders,
      recentOrders,
      portfolioHistory
    });
    accountRisk.history_available = historyAvailable;
    accountRisk.data_warnings = historyWarning ? [historyWarning] : [];

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

    risk.account_risk = accountRisk;
    if (!accountRisk.approved) {
      risk.approved = false;
      risk.reasons = [...(risk.reasons || []), ...accountRisk.locks];
    }

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
