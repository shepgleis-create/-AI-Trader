import { fetchCandidates } from '../lib/strategy.js';
import { getAiTradeDecision } from '../lib/ai.js';

const ENTRY_SCORE = 78;
const MAX_POSITIONS = 3;
const MAX_ENTRY_DOLLARS = 25;
const STOP_LOSS = -0.03;
const TAKE_PROFIT = 0.06;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  const baseUrl = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
  const cronSecret = process.env.CRON_SECRET;
  const enabled = String(process.env.AUTO_TRADING_ENABLED || '').toLowerCase() === 'true';
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!key || !secret) return res.status(500).json({ error: 'Missing Alpaca credentials' });
  if (!cronSecret) return res.status(503).json({ error: 'CRON_SECRET is not configured yet' });
  if (req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!baseUrl.includes('paper-api.alpaca.markets')) {
    return res.status(403).json({ error: 'Live endpoint rejected. Automation is paper-only.' });
  }

  const headers = {
    'APCA-API-KEY-ID': key,
    'APCA-API-SECRET-KEY': secret,
    'Content-Type': 'application/json'
  };

  try {
    const [accountRes, clockRes, positionsRes, ordersRes] = await Promise.all([
      fetch(`${baseUrl}/v2/account`, { headers }),
      fetch(`${baseUrl}/v2/clock`, { headers }),
      fetch(`${baseUrl}/v2/positions`, { headers }),
      fetch(`${baseUrl}/v2/orders?status=open&limit=100`, { headers })
    ]);

    const [account, clock, positionsRaw, ordersRaw] = await Promise.all([
      accountRes.json(), clockRes.json(), positionsRes.json(), ordersRes.json()
    ]);

    if (!accountRes.ok || !clockRes.ok || !positionsRes.ok || !ordersRes.ok) {
      return res.status(502).json({ error: 'Alpaca pre-trade checks failed' });
    }

    if (!clock.is_open) {
      return res.status(200).json({
        ok: true,
        enabled,
        action: 'none',
        reason: 'market_closed',
        next_open: clock.next_open
      });
    }

    if (account.trading_blocked || account.account_blocked) {
      return res.status(403).json({ error: 'Account is blocked from trading' });
    }

    const positions = Array.isArray(positionsRaw) ? positionsRaw : [];
    const openOrders = Array.isArray(ordersRaw) ? ordersRaw : [];
    const actions = [];

    // Exits first.
    for (const p of positions) {
      const plpc = Number(p.unrealized_plpc || 0);
      if (plpc <= STOP_LOSS || plpc >= TAKE_PROFIT) {
        const reason = plpc <= STOP_LOSS ? 'stop_loss' : 'take_profit';
        if (enabled) {
          const closeRes = await fetch(`${baseUrl}/v2/positions/${encodeURIComponent(p.symbol)}`, {
            method: 'DELETE',
            headers
          });
          const closeData = await closeRes.json().catch(() => ({}));
          actions.push({
            type: 'exit',
            symbol: p.symbol,
            reason,
            plpc,
            submitted: closeRes.ok,
            order_id: closeData?.id || null
          });
        } else {
          actions.push({ type: 'exit_dry_run', symbol: p.symbol, reason, plpc });
        }
      }
    }

    const exitingSymbols = new Set(actions.map(a => a.symbol));
    const effectivePositions = positions.filter(p => !exitingSymbols.has(p.symbol));

    // At most one AI-approved entry per daily cycle.
    if (effectivePositions.length < MAX_POSITIONS) {
      const candidates = await fetchCandidates(key, secret);
      const held = new Set(positions.map(p => p.symbol));
      const ordered = new Set(openOrders.map(o => o.symbol));
      const eligible = candidates.filter(c =>
        c.score >= 66 &&
        !held.has(c.symbol) &&
        !ordered.has(c.symbol)
      ).slice(0, 5);

      if (eligible.length) {
        let decision = null;
        let source = 'QUANT_FALLBACK';

        if (geminiKey) {
          try {
            decision = await getAiTradeDecision({
              apiKey: geminiKey,
              candidates: eligible,
              positions,
              account
            });
            source = 'LLM';
            actions.push({
              type: 'ai_decision',
              action: decision.action,
              symbol: decision.symbol,
              confidence: decision.confidence,
              rationale: decision.rationale,
              model: decision.model
            });
          } catch (error) {
            actions.push({
              type: 'ai_fallback',
              reason: String(error?.message || 'Gemini request failed').slice(0, 220)
            });
          }
        } else {
          actions.push({
            type: 'ai_fallback',
            reason: 'GEMINI_API_KEY is not configured.'
          });
        }

        if (!decision) {
          const best = eligible[0];
          decision = best && best.score >= ENTRY_SCORE
            ? {
                action: 'BUY',
                symbol: best.symbol,
                confidence: Math.min(95, Math.max(60, best.score)),
                rationale: 'Gemini unavailable, so the autonomous quant fallback selected the highest-scoring setup that passed the hard entry threshold.'
              }
            : {
                action: 'SKIP',
                symbol: '',
                confidence: 80,
                rationale: 'Gemini unavailable and no candidate passed the hard quantitative entry threshold.'
              };

          actions.push({
            type: 'quant_decision',
            action: decision.action,
            symbol: decision.symbol,
            confidence: decision.confidence,
            rationale: decision.rationale
          });
        }

        const pick = decision.action === 'BUY'
          ? eligible.find(c => c.symbol === decision.symbol)
          : null;

        // The hard quantitative/risk gate is mandatory for both LLM and fallback decisions.
        if (pick && pick.score >= ENTRY_SCORE && decision.confidence >= 60) {
          const portfolioValue = Number(account.portfolio_value || 0);
          const cash = Number(account.cash || 0);
          const notional = Math.max(1, Math.min(MAX_ENTRY_DOLLARS, portfolioValue * 0.02));

          if (cash >= notional) {
            if (enabled) {
              const orderRes = await fetch(`${baseUrl}/v2/orders`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                  symbol: pick.symbol,
                  notional: notional.toFixed(2),
                  side: 'buy',
                  type: 'market',
                  time_in_force: 'day',
                  client_order_id: `aiauto-${pick.symbol.toLowerCase()}-${Date.now()}`
                })
              });
              const order = await orderRes.json();
              actions.push({
                type: 'entry',
                decision_source: source,
                symbol: pick.symbol,
                score: pick.score,
                decision_confidence: decision.confidence,
                notional,
                submitted: orderRes.ok,
                order_id: order?.id || null,
                status: order?.status || null,
                error: orderRes.ok ? null : order?.message
              });
            } else {
              actions.push({
                type: 'entry_dry_run',
                decision_source: source,
                symbol: pick.symbol,
                score: pick.score,
                decision_confidence: decision.confidence,
                notional
              });
            }
          }
        } else if (decision.action === 'BUY' && pick) {
          actions.push({
            type: 'risk_reject',
            decision_source: source,
            symbol: pick.symbol,
            reason: 'Decision did not meet the mandatory score/confidence gate.',
            score: pick.score,
            decision_confidence: decision.confidence
          });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      mode: 'PAPER',
      enabled,
      rules: {
        entry_score: ENTRY_SCORE,
        max_positions: MAX_POSITIONS,
        max_entry_dollars: MAX_ENTRY_DOLLARS,
        stop_loss_pct: STOP_LOSS,
        take_profit_pct: TAKE_PROFIT
      },
      actions
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Automation cycle failed' });
  }
}
