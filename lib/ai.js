function outputText(response) {
  const chunks = [];
  for (const item of response?.output || []) {
    if (item?.type !== 'message') continue;
    for (const part of item?.content || []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join('\n').trim();
}

export async function getAiTradeDecision({ apiKey, candidates, positions, account }) {
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

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

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-5.6-luna',
      store: false,
      reasoning: { effort: 'low' },
      max_output_tokens: 350,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: 'You are the decision layer inside a conservative autonomous paper-trading system. Choose at most one long stock/ETF entry from the supplied candidate list, or SKIP. Do not invent symbols. Prefer not trading when the evidence is weak or conflicting. The scanner score is a heuristic, not a probability. Consider trend, momentum, RSI, volume, existing positions, diversification, and available cash. No shorts, options, leverage, or averaging down. Return only the requested structured decision.'
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({ candidates: shortlist, portfolio })
            }
          ]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'trade_decision',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['BUY', 'SKIP'] },
              symbol: { type: 'string' },
              confidence: { type: 'integer' },
              rationale: { type: 'string' }
            },
            required: ['action', 'symbol', 'confidence', 'rationale'],
            additionalProperties: false
          }
        }
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || 'OpenAI decision request failed');
  }

  const text = outputText(data);
  if (!text) throw new Error('AI returned no decision text');

  let decision;
  try {
    decision = JSON.parse(text);
  } catch {
    throw new Error('AI returned an unreadable decision');
  }

  const allowed = new Set(shortlist.map(c => c.symbol));
  if (decision.action === 'BUY' && !allowed.has(decision.symbol)) {
    throw new Error('AI selected a symbol outside the candidate list');
  }

  if (decision.action === 'SKIP') decision.symbol = '';

  return {
    action: decision.action,
    symbol: decision.symbol,
    confidence: Math.max(0, Math.min(100, Number(decision.confidence) || 0)),
    rationale: String(decision.rationale || '').slice(0, 600),
    model: 'gpt-5.6-luna'
  };
}
