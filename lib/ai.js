export async function getAiTradeDecision({ apiKey, candidates, positions, account }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const shortlist = (candidates || []).slice(0, 5).map(c => ({
    symbol: c.symbol,
    score: c.score,
    price: Number(c.price?.toFixed?.(2) ?? c.price),
    rsi14: Number(c.rsi14?.toFixed?.(1) ?? c.rsi14),
    momentum_5d_pct: Number((c.momentum_5d * 100).toFixed(2)),
    momentum_20d_pct: Number((c.momentum_20d * 100).toFixed(2)),
    volume_ratio: Number(c.volume_ratio?.toFixed?.(2) ?? c.volume_ratio),
    reasons: c.reasons || []
  }));

  const portfolio = {
    cash: Number(account?.cash || 0),
    portfolio_value: Number(account?.portfolio_value || 0),
    positions: (positions || []).map(p => ({
      symbol: p.symbol,
      qty: Number(p.qty || 0),
      market_value: Number(p.market_value || 0),
      unrealized_plpc_pct: Number((Number(p.unrealized_plpc || 0) * 100).toFixed(2))
    }))
  };

  const prompt = [
    'You are the decision layer inside a conservative autonomous paper-trading system.',
    'Choose at most one LONG stock/ETF entry from the supplied candidate list, or SKIP.',
    'Do not invent symbols. Prefer SKIP when evidence is weak or conflicting.',
    'The scanner score is a heuristic, not a probability.',
    'Consider trend, momentum, RSI, volume, existing positions, diversification, and cash.',
    'No shorts, options, leverage, or averaging down.',
    'Return only JSON matching the requested schema.',
    JSON.stringify({ candidates: shortlist, portfolio })
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
              mimeType: 'application/json',
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
    rationale: String(decision.rationale || '').slice(0, 600),
    model: 'gemini-3.8-flash'
  };
}
