import { fetchMarketScan } from '../lib/strategy.js';
import { getAiTradeDecision } from '../lib/ai.js';
import { buildCandidateContext } from '../lib/context.js';
import { evaluateEntry, entryThresholdForRegime, getPortfolioRisk } from '../lib/risk.js';

const LEGACY_STOP_LOSS = -0.03;
const LEGACY_TAKE_PROFIT = 0.06;

function priceRound(n) {
  return Number(n).toFixed(2);
}

async function latestPrice(symbol, key, secret) {
  const url = new URL('https://data.alpaca.markets/v2/stocks/snapshots');
  url.searchParams.set('symbols', symbol);
  url.searchParams.set('feed', 'iex');
  const r = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID': key,
      'APCA-API-SECRET-KEY': secret
    }
  });
  const data = await r.json();
  if (!r.ok) return null;
  const s = data?.snapshots?.[symbol] || data?.[symbol];
  return Number(
    s?.latestTrade?.p ||
    s?.minuteBar?.c ||
    s?.dailyBar?.c ||
    0
  ) || null;
}

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
      fetch(`${baseUrl}/v2/orders?status=open&limit=100&nested=true`, { headers })
    ]);

    const [account, clock, positionsRaw, ordersRaw] = await Promise.all([
      accountRes.json(), clockRes.json(), positionsRes.json(), ordersRes.json()
    ]);

    if (!accountRes.ok || !clockRes.ok || !positionsRes.ok || !ordersRes.ok) {
      return res.status(502).json({ error: 'Alpaca pre-trade checks failed' });
    }

    const positions = Array.isArray(positionsRaw) ? positionsRaw : [];
    const openOrders = Array.isArray(ordersRaw) ? ordersRaw : [];
    const portfolioRisk = getPortfolioRisk(account, positions);

    if (!clock.is_open) {
      return res.status(200).json({
        ok: true,
        enabled,
        action: 'none',
        reason: 'market_closed',
        next_open: clock.next_open,
        portfolio_risk: portfolioRisk
      });
    }

    if (account.trading_blocked || account.account_blocked) {
      return res.status(403).json({ error: 'Account is blocked from trading' });
    }

    const actions = [];

    // Legacy safety net for positions opened before bracket orders were added.
    const protectedSymbols = new Set();
    for (const o of openOrders) {
      if (o?.side === 'sell' && o?.symbol) protectedSymbols.add(o.symbol);
      for (const leg of (Array.isArray(o?.legs) ? o.legs : [])) {
        if (leg?.side === 'sell') protectedSymbols.add(leg.symbol || o.symbol);
      }
    }

    for (const p of positions) {
      if (protectedSymbols.has(p.symbol)) continue;
      const plpc = Number(p.unrealized_plpc || 0);
      if (plpc <= LEGACY_STOP_LOSS || plpc >= LEGACY_TAKE_PROFIT) {
        const reason = plpc <= LEGACY_STOP_LOSS ? 'legacy_stop_loss' : 'legacy_take_profit';
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

    if (portfolioRisk.daily_loss_lock) {
      actions.push({
        type: 'entry_lock',
        reason: 'Daily loss kill switch active',
        day_return: portfolioRisk.day_return
      });
      return res.status(200).json({
        ok: true,
        mode: 'PAPER',
        enabled,
        portfolio_risk: portfolioRisk,
        actions
      });
    }

    if (portfolioRisk.exposure_lock || portfolioRisk.position_lock) {
      actions.push({
        type: 'entry_lock',
        reason: portfolioRisk.exposure_lock
          ? 'Portfolio exposure cap reached'
          : 'Maximum open positions reached'
      });
      return res.status(200).json({
        ok: true,
        mode: 'PAPER',
        enabled,
        portfolio_risk: portfolioRisk,
        actions
      });
    }

    const scan = await fetchMarketScan(key, secret);
    const entryThreshold = entryThresholdForRegime(scan.regime?.label);
    const held = new Set(positions.map(p => p.symbol));
    const ordered = new Set(openOrders.map(o => o.symbol));

    const eligible = scan.candidates
      .filter(c =>
        c.score >= Math.max(68, entryThreshold - 10) &&
        !held.has(c.symbol) &&
        !ordered.has(c.symbol)
      )
      .slice(0, 5);

    if (!eligible.length) {
      actions.push({
        type: 'no_setup',
        reason: 'No candidate met the regime-adjusted review threshold',
        regime: scan.regime?.label,
        threshold: entryThreshold
      });
      return res.status(200).json({
        ok: true,
        mode: 'PAPER',
        enabled,
        regime: scan.regime,
        portfolio_risk: portfolioRisk,
        actions
      });
    }

    const candidateContext = await buildCandidateContext(eligible, key, secret);

    let decision = null;
    let source = 'QUANT_FALLBACK';

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
          reason: String(error?.message || 'Gemini request failed').slice(0, 260)
        });
      }
    }

    if (!decision) {
      const best = eligible[0];
      decision = best && best.score >= entryThreshold
        ? {
            action: 'BUY',
            symbol: best.symbol,
            confidence: Math.min(95, Math.max(60, best.score)),
            rationale: 'Gemini unavailable; quantitative fallback selected the highest-scoring candidate above the regime-adjusted threshold.'
          }
        : {
            action: 'SKIP',
            symbol: '',
            confidence: 80,
            rationale: 'No candidate cleared the regime-adjusted quantitative entry threshold.'
          };

      actions.push({
        type: 'quant_decision',
        action: decision.action,
        symbol: decision.symbol,
        confidence: decision.confidence,
        rationale: decision.rationale
      });
    }

    if (decision.action !== 'BUY') {
      actions.push({ type: 'skip', reason: decision.rationale });
      return res.status(200).json({
        ok: true,
        mode: 'PAPER',
        enabled,
        regime: scan.regime,
        portfolio_risk: portfolioRisk,
        actions
      });
    }

    const pick = eligible.find(c => c.symbol === decision.symbol);
    if (!pick) {
      actions.push({ type: 'risk_reject', reason: 'Selected symbol was not in eligible shortlist' });
      return res.status(200).json({ ok: true, mode: 'PAPER', enabled, actions });
    }

    const risk = evaluateEntry({
      account,
      positions,
      candidate: pick,
      regime: scan.regime,
      eventContext: candidateContext[pick.symbol],
      confidence: decision.confidence
    });

    actions.push({
      type: 'risk_check',
      symbol: pick.symbol,
      approved: risk.approved,
      reasons: risk.reasons,
      threshold: risk.threshold,
      sizing: risk.sizing,
      event_risk: candidateContext[pick.symbol]?.risk || null
    });

    if (!risk.approved) {
      return res.status(200).json({
        ok: true,
        mode: 'PAPER',
        enabled,
        regime: scan.regime,
        portfolio_risk: portfolioRisk,
        actions
      });
    }

    const px = await latestPrice(pick.symbol, key, secret) || Number(pick.price);
    const sizing = risk.sizing;
    const qty = px > 0 ? Number((sizing.notional / px).toFixed(8)) : 0;

    if (!(qty > 0)) {
      actions.push({ type: 'risk_reject', reason: 'Could not calculate a valid order quantity' });
      return res.status(200).json({ ok: true, mode: 'PAPER', enabled, actions });
    }

    const stopPrice = priceRound(px * (1 - sizing.stop_pct));
    const takeProfitPrice = priceRound(px * (1 + sizing.take_profit_pct));
    const clientId = `aitr-${source === 'LLM' ? 'g' : 'q'}-${pick.symbol.toLowerCase()}-s${pick.score}-c${Math.round(decision.confidence)}-${String(Date.now()).slice(-7)}`;

    const planned = {
      type: enabled ? 'entry' : 'entry_dry_run',
      decision_source: source,
      symbol: pick.symbol,
      score: pick.score,
      decision_confidence: decision.confidence,
      notional: sizing.notional,
      qty,
      reference_price: px,
      stop_price: Number(stopPrice),
      take_profit_price: Number(takeProfitPrice),
      client_order_id: clientId
    };

    if (!enabled) {
      actions.push(planned);
    } else {
      const orderRes = await fetch(`${baseUrl}/v2/orders`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          symbol: pick.symbol,
          qty: qty.toString(),
          side: 'buy',
          type: 'market',
          time_in_force: 'day',
          order_class: 'bracket',
          take_profit: { limit_price: takeProfitPrice },
          stop_loss: { stop_price: stopPrice },
          client_order_id: clientId
        })
      });
      const order = await orderRes.json();

      actions.push({
        ...planned,
        submitted: orderRes.ok,
        order_id: order?.id || null,
        status: order?.status || null,
        error: orderRes.ok ? null : order?.message || 'Bracket order rejected'
      });
    }

    return res.status(200).json({
      ok: true,
      mode: 'PAPER',
      enabled,
      regime: scan.regime,
      portfolio_risk: portfolioRisk,
      rules: {
        regime_entry_threshold: entryThreshold,
        daily_loss_stop_pct: -0.02,
        max_exposure_pct: 0.30,
        max_positions: 3,
        max_entry_dollars_during_calibration: 25
      },
      actions
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Automation cycle failed' });
  }
}
