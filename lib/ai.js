export async function getAiTradeDecision({
  apiKey,
  candidates,
  positions,
  account,
  marketContext = {},
  candidateContext = {}
}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const shortlist = (candidates || []).slice(0, 5).map(c => {
    const ctx = candidateContext?.[c.symbol] || {};
    return {
      symbol: c.symbol,
      score: c.score,
      price: Number(c.price?.toFixed?.(2) ?? c.price),
      rsi14: Number(c.rsi14?.toFixed?.(1) ?? c.rsi14),
      atr_pct: Number(((c.atr_pct || 0) * 100).toFixed(2)),
      volatility_20d_pct: Number(((c.volatility_20d || 0) * 100).toFixed(1)),
      relative_strength_20d_pct: Number(((c.relative_strength_20d || 0) * 100).toFixed(2)),
      relative_strength_percentile: Number(((c.rs_percentile || 0) * 100).toFixed(1)),
      risk_adjusted_momentum: Number((c.risk_adjusted_momentum || 0).toFixed(2)),
      risk_adjusted_momentum_percentile: Number(((c.risk_adjusted_momentum_percentile || 0) * 100).toFixed(1)),
      setup_type: c.setup_type || 'TREND',
      spread_pct: c.spread_pct == null ? null : Number((c.spread_pct * 100).toFixed(3)),
      day_change_pct: Number(((c.day_change || 0) * 100).toFixed(2)),
      gap_pct: Number(((c.gap_pct || 0) * 100).toFixed(2)),
      move_from_open_pct: Number(((c.move_from_open_pct || 0) * 100).toFixed(2)),
      beta_60d: c.beta_60d == null ? null : Number(c.beta_60d.toFixed(2)),
      sector_proxy: c.sector_proxy || null,
      sector_correlation: c.sector_correlation == null ? null : Number(c.sector_correlation.toFixed(2)),
      sector_return_20d_pct: c.sector_return_20d == null ? null : Number((c.sector_return_20d * 100).toFixed(2)),
      sector_strength_percentile: c.sector_strength_percentile == null ? null : Number((c.sector_strength_percentile * 100).toFixed(1)),
      sector_rank: c.sector_rank || null,
      data_age_seconds: c.data_age_seconds == null ? null : Math.round(c.data_age_seconds),
      historical_edge: c.historical_edge ? {
        samples: c.historical_edge.samples,
        win_rate_pct: c.historical_edge.win_rate == null ? null : Number((c.historical_edge.win_rate * 100).toFixed(1)),
        avg_5d_return_pct: c.historical_edge.avg_5d_return == null ? null : Number((c.historical_edge.avg_5d_return * 100).toFixed(2)),
        median_5d_return_pct: c.historical_edge.median_5d_return == null ? null : Number((c.historical_edge.median_5d_return * 100).toFixed(2))
      } : null,
      momentum_5d_pct: Number((c.momentum_5d * 100).toFixed(2)),
      momentum_20d_pct: Number((c.momentum_20d * 100).toFixed(2)),
      avg_dollar_volume_20d: Math.round(c.avg_dollar_volume_20d || 0),
      volume_ratio: Number(c.volume_ratio?.toFixed?.(2) ?? c.volume_ratio),
      reasons: c.reasons || [],
      recent_headlines: (ctx.headlines || []).slice(0, 4).map(x => x.headline),
      event_risk: ctx.risk || { level: 'LOW', hard_block: false },
      corporate_actions: (ctx.corporate_actions || []).slice(0, 4)
    };
  });

  const portfolio = {
    cash: Number(account?.cash || 0),
    portfolio_value: Number(account?.portfolio_value || 0),
    equity: Number(account?.equity || account?.portfolio_value || 0),
    last_equity: Number(account?.last_equity || 0),
    positions: (positions || []).map(p => ({
      symbol: p.symbol,
      qty: Number(p.qty || 0),
      market_value: Number(p.market_value || 0),
      unrealized_plpc_pct: Number((Number(p.unrealized_plpc || 0) * 100).toFixed(2))
    }))
  };

  const prompt = [
    'You are one decision layer inside a conservative autonomous PAPER-trading system.',
    'Choose at most one LONG stock/ETF entry from the supplied candidate list, or SKIP.',
    'Do not invent symbols. Prefer SKIP when evidence is weak, overextended, event-risky, or conflicting.',
    'The scanner score and your confidence are NOT probabilities of profit.',
    'Consider market regime, daily breadth, multi-day market participation, setup type, trend, momentum, RSI, ATR, volatility, beta, inferred sector exposure, sector leadership rank, overnight gap behavior, move since the open, cross-sectional relative strength, risk-adjusted momentum, bid/ask spread, quote freshness, same-symbol historical analogs, liquidity, recent headlines, corporate actions, existing positions, diversification, and cash.',
    'Do not override a hard event-risk flag. No shorts, options, leverage, averaging down, or revenge trading.',
    'Return only JSON matching the requested schema.',
    JSON.stringify({
      market: marketContext,
      candidates: shortlist,
      portfolio
    })
  ].join('\n');

  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseFormat: {
            text: {
              mimeType: 'APPLICATION_JSON',
              schema: {
                type: 'object',
                properties: {
                  action: { type: 'string', enum: ['BUY', 'SKIP'] },
                  symbol: { type: 'string' },
                  confidence: { type: 'integer' },
                  rationale: { type: 'string' }
                },
                required: ['action', 'symbol', 'confidence', 'rationale']
              }
            }
          }
        }
      })
    }
  );

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || 'Gemini decision request failed');
  }

  const text = data?.candidates?.[0]?.content?.parts
    ?.map(p => p?.text || '')
    .join('')
    .trim();

  if (!text) throw new Error('Gemini returned no decision');

  let decision;
  try {
    decision = JSON.parse(text);
  } catch {
    throw new Error('Gemini returned an unreadable decision');
  }

  const allowed = new Set(shortlist.map(c => c.symbol));
  if (decision.action === 'BUY' && !allowed.has(decision.symbol)) {
    throw new Error('Gemini selected a symbol outside the candidate list');
  }

  if (decision.action === 'SKIP') decision.symbol = '';

  return {
    action: decision.action,
    symbol: decision.symbol,
    confidence: Math.max(0, Math.min(100, Number(decision.confidence) || 0)),
    rationale: String(decision.rationale || '').slice(0, 900),
    model: 'gemini-3.8-flash'
  };
}
