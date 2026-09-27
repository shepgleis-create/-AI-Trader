import { fetchMarketScan, fetchBarsForSymbols, marketRiskMetrics, SECTOR_ETFS } from '../lib/strategy.js';
import { getAiTradeDecision } from '../lib/ai.js';
import { buildCandidateContext } from '../lib/context.js';
import { evaluateEntry, entryThresholdForRegime, getPortfolioRisk, maxPortfolioCorrelation } from '../lib/risk.js';
import { logTraderEvent } from '../lib/journal.js';
import { isDashboardAuthorized } from '../lib/auth.js';
import { buildAccountRisk } from '../lib/account-risk.js';
import { getIntradayConfirmation } from '../lib/intraday.js';
import { candidateReadiness } from '../lib/readiness.js';
import { newDecisionCycleId, saveDecisionMemory } from '../lib/decision-memory.js';

const LEGACY_STOP_LOSS = -0.03;
const LEGACY_TAKE_PROFIT = 0.06;
const MAX_AUTONOMOUS_ENTRIES_PER_DAY = 1;
const SYMBOL_COOLDOWN_DAYS = 5;
const ENTRY_TIMEOUT_MINUTES = 20;
const ENTRY_LIMIT_CUSHION_PCT = 0.001;

function priceRound(n) {
  return Number(n).toFixed(2);
}

async function alpacaFetch(url, options = {}, attempts = 3) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await fetch(url, options);
    if (last.status !== 429 && last.status < 500) return last;
    if (i < attempts - 1) {
      const retryAfter = Number(last.headers.get('retry-after') || 0);
      const wait = retryAfter > 0 ? retryAfter * 1000 : 350 * (i + 1);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
  return last;
}

function isOpenOrderStatus(status) {
  return ['accepted','new','partially_filled','calculated','pending_new','pending_cancel','accepted_for_bidding']
    .includes(String(status || '').toLowerCase());
}

function marketEntryWindow(clock) {
  const now = new Date(clock?.timestamp || Date.now());
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(now);

  const hour = Number(parts.find(p => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value || 0);
  const minutes = hour * 60 + minute;
  const firstAllowed = 9 * 60 + 45;

  const nextClose = new Date(clock?.next_close || 0).getTime();
  const minutesToClose = nextClose > 0 ? (nextClose - now.getTime()) / 60000 : null;

  if (minutes < firstAllowed) {
    return { allowed: false, phase: 'OPENING_NOISE', reason: 'Avoiding the first 15 minutes after the opening bell', minutes_to_close: minutesToClose };
  }
  if (minutesToClose != null && minutesToClose <= 15) {
    return { allowed: false, phase: 'CLOSING_NOISE', reason: 'Avoiding new entries in the final 15 minutes', minutes_to_close: minutesToClose };
  }

  return { allowed: true, phase: 'NORMAL', reason: null, minutes_to_close: minutesToClose };
}

async function latestExecutionSnapshot(symbol, key, secret) {
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
  if (!s) return null;

  const quote = s?.latestQuote || s?.latest_quote;
  const trade = s?.latestTrade || s?.latest_trade;
  const minute = s?.minuteBar || s?.minute_bar;
  const daily = s?.dailyBar || s?.daily_bar;

  const price = Number(trade?.p || minute?.c || daily?.c || 0) || null;
  const bid = Number(quote?.bp || 0);
  const ask = Number(quote?.ap || 0);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
  const spreadPct = mid > 0 && ask >= bid ? (ask - bid) / mid : null;
  const timestamp = quote?.t || trade?.t || minute?.t || daily?.t || null;
  const ageSeconds = timestamp
    ? Math.max(0, (Date.now() - new Date(timestamp).getTime()) / 1000)
    : null;

  return { price, bid, ask, spread_pct: spreadPct, age_seconds: ageSeconds, timestamp };
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
  const cronAuthorized = req.headers.authorization === `Bearer ${cronSecret}`;
  const dashboardAuthorized = isDashboardAuthorized(req);
  if (!cronAuthorized && !dashboardAuthorized) {
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
    const historyUrl = new URL(`${baseUrl}/v2/account/portfolio/history`);
    historyUrl.searchParams.set('period','1M');
    historyUrl.searchParams.set('timeframe','1D');

    const [accountRes, clockRes, positionsRes, ordersRes, recentOrdersRes, historyRes] = await Promise.all([
      alpacaFetch(`${baseUrl}/v2/account`, { headers }),
      alpacaFetch(`${baseUrl}/v2/clock`, { headers }),
      alpacaFetch(`${baseUrl}/v2/positions`, { headers }),
      alpacaFetch(`${baseUrl}/v2/orders?status=open&limit=100&nested=true`, { headers }),
      alpacaFetch(`${baseUrl}/v2/orders?status=all&limit=500&direction=desc&nested=true`, { headers }),
      alpacaFetch(historyUrl, { headers })
    ]);

    const [account, clock, positionsRaw, ordersRaw, recentOrdersRaw, historyRaw] = await Promise.all([
      accountRes.json().catch(() => ({})),
      clockRes.json().catch(() => ({})),
      positionsRes.json().catch(() => ([])),
      ordersRes.json().catch(() => ([])),
      recentOrdersRes.json().catch(() => ([])),
      historyRes.json().catch(() => ({}))
    ]);

    const checks = [
      { name: 'account', response: accountRes, body: account },
      { name: 'clock', response: clockRes, body: clock },
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
      const summary = failed.map(x => `${x.name} HTTP ${x.status}${x.message ? ': ' + x.message : ''}`).join(' · ');
      return res.status(502).json({
        error: `Alpaca core check failed — ${summary}`,
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
    const portfolioRisk = getPortfolioRisk(account, positions);
    const accountRisk = buildAccountRisk({
      account,
      positions,
      openOrders,
      recentOrders,
      portfolioHistory
    });
    accountRisk.history_available = historyAvailable;
    accountRisk.data_warnings = historyWarning ? [historyWarning] : [];
    const entryWindow = marketEntryWindow(clock);

    const today = new Date().toISOString().slice(0,10);
    const autonomousParents = recentOrders.filter(o =>
      o?.side === 'buy' &&
      String(o?.client_order_id || '').startsWith('aitr-')
    );
    const entriesToday = autonomousParents.filter(o =>
      String(o?.submitted_at || '').slice(0,10) === today
    );
    const cooldownCutoff = Date.now() - SYMBOL_COOLDOWN_DAYS * 86400000;
    const recentlyTradedSymbols = new Set(
      autonomousParents
        .filter(o =>
          Number(o?.filled_qty || 0) > 0 &&
          new Date(o?.submitted_at || 0).getTime() >= cooldownCutoff
        )
        .map(o => o.symbol)
        .filter(Boolean)
    );

    if (!clock.is_open) {
      logTraderEvent('market_closed', { enabled, next_open: clock.next_open });
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

    // Cancel autonomous entry orders that never filled quickly enough.
    for (const o of openOrders) {
      if (
        o?.side !== 'buy' ||
        !String(o?.client_order_id || '').startsWith('aitr-') ||
        !o?.id
      ) continue;

      const submitted = new Date(o?.submitted_at || 0).getTime();
      if (!(submitted > 0)) continue;

      const ageMinutes = (Date.now() - submitted) / 60000;
      if (ageMinutes < ENTRY_TIMEOUT_MINUTES) continue;

      if (!enabled) {
        actions.push({
          type: 'stale_entry_cancel_dry_run',
          symbol: o.symbol,
          age_minutes: Number(ageMinutes.toFixed(1)),
          order_id: o.id
        });
        continue;
      }

      const cancelRes = await fetch(`${baseUrl}/v2/orders/${encodeURIComponent(o.id)}`, {
        method: 'DELETE',
        headers
      });

      logTraderEvent('stale_entry_cancel', {
        symbol: o.symbol,
        order_id: o.id,
        age_minutes: ageMinutes,
        submitted: cancelRes.ok
      });

      actions.push({
        type: 'stale_entry_cancel',
        symbol: o.symbol,
        age_minutes: Number(ageMinutes.toFixed(1)),
        order_id: o.id,
        submitted: cancelRes.ok
      });
    }

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

    // Ratchet autonomous bracket stops upward once a position is profitable.
    for (const p of positions) {
      const plpc = Number(p.unrealized_plpc || 0);
      if (plpc < 0.03) continue;

      const parent = autonomousParents.find(o =>
        o.symbol === p.symbol &&
        String(o.client_order_id || '').startsWith('aitr-') &&
        Array.isArray(o.legs)
      );
      if (!parent) continue;

      const stopLeg = parent.legs.find(leg =>
        leg?.side === 'sell' &&
        ['stop','stop_limit'].includes(String(leg?.type || '').toLowerCase()) &&
        isOpenOrderStatus(leg?.status)
      );
      if (!stopLeg?.id) continue;

      const entry = Number(p.avg_entry_price || 0);
      const current = Number(p.current_price || 0);
      const existingStop = Number(stopLeg.stop_price || 0);
      if (!(entry > 0 && current > 0)) continue;

      let desiredStop = entry * 1.001;
      if (plpc >= 0.05) desiredStop = Math.max(desiredStop, current * 0.975);
      if (plpc >= 0.08) desiredStop = Math.max(desiredStop, current * 0.965);

      desiredStop = Number(priceRound(desiredStop));
      if (!(desiredStop > existingStop * 1.0025)) continue;
      if (desiredStop >= current * 0.995) continue;

      if (!enabled) {
        actions.push({
          type: 'profit_protection_dry_run',
          symbol: p.symbol,
          plpc,
          current_stop: existingStop || null,
          proposed_stop: desiredStop
        });
        continue;
      }

      const patchRes = await fetch(`${baseUrl}/v2/orders/${encodeURIComponent(stopLeg.id)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ stop_price: desiredStop.toFixed(2) })
      });
      const patched = await patchRes.json().catch(() => ({}));

      logTraderEvent('profit_protection', {
        symbol: p.symbol,
        plpc,
        previous_stop: existingStop || null,
        requested_stop: desiredStop,
        submitted: patchRes.ok,
        replacement_order_id: patched?.id || null
      });

      actions.push({
        type: 'profit_protection',
        symbol: p.symbol,
        plpc,
        previous_stop: existingStop || null,
        requested_stop: desiredStop,
        submitted: patchRes.ok,
        replacement_order_id: patched?.id || null,
        error: patchRes.ok ? null : patched?.message || 'Stop replacement rejected'
      });
    }

    if (entryWindow.phase === 'CLOSING_NOISE') {
      const autonomousSymbols = new Set(autonomousParents.map(o => o.symbol).filter(Boolean));

      for (const p of positions) {
        if (!autonomousSymbols.has(p.symbol)) continue;

        if (!enabled) {
          actions.push({
            type: 'end_of_day_flatten_dry_run',
            symbol: p.symbol,
            reason: 'Fractional DAY protection is not relied on overnight during calibration'
          });
          continue;
        }

        const symbolOrders = openOrders.filter(o => o.symbol === p.symbol && o?.id);
        for (const o of symbolOrders) {
          await fetch(`${baseUrl}/v2/orders/${encodeURIComponent(o.id)}`, {
            method: 'DELETE',
            headers
          }).catch(() => null);
        }

        let closeRes = null;
        let closeData = {};
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (attempt > 1) await new Promise(resolve => setTimeout(resolve, 700));
          closeRes = await fetch(`${baseUrl}/v2/positions/${encodeURIComponent(p.symbol)}`, {
            method: 'DELETE',
            headers
          });
          closeData = await closeRes.json().catch(() => ({}));
          if (closeRes.ok) break;
        }

        logTraderEvent('end_of_day_flatten', {
          symbol: p.symbol,
          submitted: Boolean(closeRes?.ok),
          order_id: closeData?.id || null
        });

        actions.push({
          type: 'end_of_day_flatten',
          symbol: p.symbol,
          submitted: Boolean(closeRes?.ok),
          order_id: closeData?.id || null,
          error: closeRes?.ok ? null : closeData?.message || 'Close rejected after retries'
        });
      }
    }

    if (!entryWindow.allowed) {
      logTraderEvent('entry_lock', { reason: entryWindow.reason, phase: entryWindow.phase, enabled });
      actions.push({
        type: 'entry_lock',
        reason: entryWindow.reason,
        phase: entryWindow.phase
      });
      return res.status(200).json({
        ok: true,
        mode: 'PAPER',
        enabled,
        market_phase: entryWindow.phase,
        portfolio_risk: portfolioRisk,
        actions
      });
    }

    if (enabled && !historyAvailable) {
      logTraderEvent('entry_lock', {
        reason: 'history_unavailable',
        warning: historyWarning,
        enabled
      });
      actions.push({
        type: 'entry_lock',
        reason: 'Account history unavailable; automatic execution fails closed',
        warning: historyWarning
      });
      return res.status(200).json({
        ok: true,
        mode: 'PAPER',
        enabled,
        portfolio_risk: portfolioRisk,
        account_risk: accountRisk,
        actions
      });
    }

    if (!accountRisk.approved) {
      logTraderEvent('entry_lock', {
        reason: 'account_risk',
        locks: accountRisk.locks,
        drawdown_pct: accountRisk.drawdown_pct,
        trailing_week_return: accountRisk.trailing_week_return,
        open_risk_pct: accountRisk.open_risk_pct,
        consecutive_losses: accountRisk.consecutive_autonomous_losses,
        enabled
      });
      actions.push({
        type: 'entry_lock',
        reason: accountRisk.locks.join(' · '),
        account_risk: accountRisk
      });
      return res.status(200).json({
        ok: true,
        mode: 'PAPER',
        enabled,
        portfolio_risk: portfolioRisk,
        account_risk: accountRisk,
        actions
      });
    }

    if (portfolioRisk.daily_loss_lock) {
      logTraderEvent('entry_lock', { reason: 'daily_loss', day_return: portfolioRisk.day_return, enabled });
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

    if (entriesToday.length >= MAX_AUTONOMOUS_ENTRIES_PER_DAY) {
      logTraderEvent('entry_lock', {
        reason: 'daily_entry_limit',
        entries_today: entriesToday.length,
        limit: MAX_AUTONOMOUS_ENTRIES_PER_DAY,
        enabled
      });
      actions.push({
        type: 'entry_lock',
        reason: 'Daily autonomous entry limit reached',
        entries_today: entriesToday.length,
        limit: MAX_AUTONOMOUS_ENTRIES_PER_DAY
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
      logTraderEvent('entry_lock', { reason: portfolioRisk.exposure_lock ? 'exposure' : 'position_limit', exposure_pct: portfolioRisk.exposure_pct, positions: positions.length, enabled });
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
    const cycleId = newDecisionCycleId('auto');
    const entryThreshold = entryThresholdForRegime(scan.regime?.label);
    const held = new Set(positions.map(p => p.symbol));
    const ordered = new Set(openOrders.map(o => o.symbol));

    const eligible = scan.candidates
      .filter(c =>
        c.score >= Math.max(68, entryThreshold - 10) &&
        !held.has(c.symbol) &&
        !ordered.has(c.symbol) &&
        !recentlyTradedSymbols.has(c.symbol)
      )
      .slice(0, 5);

    if (!eligible.length) {
      const observed = scan.candidates.slice(0, 5);
      const readinessBySymbol = Object.fromEntries(
        observed.map(c => [c.symbol, candidateReadiness(c, scan.regime, {})])
      );
      const noSetupDecision = {
        action: 'SKIP',
        symbol: '',
        confidence: 100,
        rationale: 'No candidate met the regime-adjusted review threshold.'
      };
      const memory = await saveDecisionMemory({
        cycle_id: cycleId,
        origin: 'auto_cycle',
        mode: 'PAPER',
        execution_enabled: enabled,
        source: 'SYSTEM',
        model: 'scanner',
        decision: noSetupDecision,
        stage: 'NO_SETUP',
        regime: scan.regime,
        account_risk: accountRisk,
        portfolio_risk: portfolioRisk,
        meta: { threshold: entryThreshold, market_phase: entryWindow.phase },
        candidates: observed,
        readiness_by_symbol: readinessBySymbol
      });

      logTraderEvent('no_setup', { regime: scan.regime?.label, threshold: entryThreshold, enabled, memory_saved: memory.saved });
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
        memory,
        actions
      });
    }

    const candidateContext = await buildCandidateContext(eligible, key, secret);
    const readinessBySymbol = Object.fromEntries(
      eligible.map(c => [c.symbol, candidateReadiness(c, scan.regime, candidateContext[c.symbol])])
    );

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
        logTraderEvent('model_decision', { source, action: decision.action, symbol: decision.symbol, confidence: decision.confidence, model: decision.model, enabled });
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

      logTraderEvent('model_decision', { source: 'QUANT_FALLBACK', action: decision.action, symbol: decision.symbol, confidence: decision.confidence, enabled });
      actions.push({
        type: 'quant_decision',
        action: decision.action,
        symbol: decision.symbol,
        confidence: decision.confidence,
        rationale: decision.rationale
      });
    }

    const persistDecision = async (stage, extra = {}) => saveDecisionMemory({
      cycle_id: cycleId,
      origin: 'auto_cycle',
      mode: 'PAPER',
      execution_enabled: enabled,
      source,
      model: source === 'LLM' ? decision?.model : 'quant-fallback-v2',
      decision,
      stage,
      regime: scan.regime,
      account_risk: accountRisk,
      portfolio_risk: portfolioRisk,
      risk: extra.risk || null,
      intraday: extra.intraday || null,
      execution: extra.execution || null,
      meta: {
        threshold: entryThreshold,
        market_phase: entryWindow.phase,
        ...extra.meta
      },
      candidates: eligible,
      candidate_context: candidateContext,
      readiness_by_symbol: readinessBySymbol
    });

    if (decision.action !== 'BUY') {
      const memory = await persistDecision('MODEL_SKIP');
      logTraderEvent('skip', { source, reason: decision.rationale, regime: scan.regime?.label, enabled, memory_saved: memory.saved });
      actions.push({ type: 'skip', reason: decision.rationale });
      return res.status(200).json({
        ok: true,
        mode: 'PAPER',
        enabled,
        regime: scan.regime,
        portfolio_risk: portfolioRisk,
        memory,
        actions
      });
    }

    const pick = eligible.find(c => c.symbol === decision.symbol);
    if (!pick) {
      const memory = await persistDecision('INVALID_SELECTION');
      actions.push({ type: 'risk_reject', reason: 'Selected symbol was not in eligible shortlist' });
      return res.status(200).json({ ok: true, mode: 'PAPER', enabled, memory, actions });
    }

    let portfolioCorrelation = null;
    let sectorOverlap = { candidate_sector: pick.sector_proxy || null, count: 0, symbols: [] };
    if (positions.length) {
      const correlationSymbols = [...new Set([pick.symbol, ...positions.map(p => p.symbol), 'SPY', ...SECTOR_ETFS])];
      const correlationBars = await fetchBarsForSymbols(correlationSymbols, key, secret, 100);
      const heldBars = Object.fromEntries(
        positions.map(p => [p.symbol, correlationBars[p.symbol] || []])
      );
      portfolioCorrelation = maxPortfolioCorrelation(
        correlationBars[pick.symbol] || [],
        heldBars
      );

      if (pick.sector_proxy) {
        const sameSector = positions
          .map(p => ({
            symbol: p.symbol,
            metrics: marketRiskMetrics(correlationBars[p.symbol] || [], correlationBars)
          }))
          .filter(x =>
            x.metrics.sector_proxy === pick.sector_proxy &&
            Number(x.metrics.sector_correlation || 0) >= 0.55
          )
          .map(x => x.symbol);

        sectorOverlap = {
          candidate_sector: pick.sector_proxy,
          count: sameSector.length,
          symbols: sameSector
        };
      }
    }

    const risk = evaluateEntry({
      account,
      positions,
      candidate: pick,
      regime: scan.regime,
      eventContext: candidateContext[pick.symbol],
      confidence: decision.confidence,
      portfolioCorrelation,
      sectorOverlap
    });

    logTraderEvent('risk_check', { symbol: pick.symbol, approved: risk.approved, reasons: risk.reasons, threshold: risk.threshold, correlation: risk.portfolio_correlation || null, enabled });
    actions.push({
      type: 'risk_check',
      symbol: pick.symbol,
      approved: risk.approved,
      reasons: risk.reasons,
      threshold: risk.threshold,
      sizing: risk.sizing,
      sector_overlap: risk.sector_overlap,
      event_risk: candidateContext[pick.symbol]?.risk || null
    });

    if (!risk.approved) {
      const memory = await persistDecision('RISK_REJECTED', { risk });
      logTraderEvent('risk_reject', { symbol: pick.symbol, reasons: risk.reasons, enabled, memory_saved: memory.saved });
      return res.status(200).json({
        ok: true,
        mode: 'PAPER',
        enabled,
        regime: scan.regime,
        portfolio_risk: portfolioRisk,
        memory,
        actions
      });
    }

    const execution = await latestExecutionSnapshot(pick.symbol, key, secret);
    if (!execution?.price) {
      const memory = await persistDecision('EXECUTION_DATA_REJECTED', { risk, execution });
      actions.push({ type: 'risk_reject', reason: 'Could not obtain a fresh execution snapshot' });
      return res.status(200).json({ ok: true, mode: 'PAPER', enabled, memory, actions });
    }
    if (execution.spread_pct == null || execution.spread_pct > 0.005) {
      const reason = execution.spread_pct == null
        ? 'No valid bid/ask quote for final execution check'
        : 'Final bid/ask spread exceeded 0.50%';
      logTraderEvent('risk_reject', { symbol: pick.symbol, reason, execution, enabled });
      actions.push({ type: 'risk_reject', symbol: pick.symbol, reason, execution });
      const memory = await persistDecision('EXECUTION_SPREAD_REJECTED', { risk, execution, meta: { rejection_reason: reason } });
      return res.status(200).json({ ok: true, mode: 'PAPER', enabled, memory, actions });
    }
    if (execution.age_seconds != null && execution.age_seconds > 300) {
      const reason = 'Final execution quote is older than 5 minutes';
      logTraderEvent('risk_reject', { symbol: pick.symbol, reason, execution, enabled });
      actions.push({ type: 'risk_reject', symbol: pick.symbol, reason, execution });
      const memory = await persistDecision('EXECUTION_STALE_REJECTED', { risk, execution, meta: { rejection_reason: reason } });
      return res.status(200).json({ ok: true, mode: 'PAPER', enabled, memory, actions });
    }

    const intraday = await getIntradayConfirmation(pick.symbol, key, secret);
    if (!intraday.approved) {
      const reason = intraday.reasons?.join(' · ') || 'Intraday execution confirmation failed';
      logTraderEvent('risk_reject', {
        symbol: pick.symbol,
        reason,
        intraday,
        enabled
      });
      actions.push({
        type: 'risk_reject',
        symbol: pick.symbol,
        reason,
        intraday
      });
      const memory = await persistDecision('INTRADAY_REJECTED', {
        risk,
        intraday,
        execution,
        meta: { rejection_reason: reason }
      });
      return res.status(200).json({
        ok: true,
        mode: 'PAPER',
        enabled,
        regime: scan.regime,
        portfolio_risk: portfolioRisk,
        account_risk: accountRisk,
        memory,
        actions
      });
    }

    const px = execution.ask > 0 ? execution.ask : execution.price;
    const sizing = risk.sizing;
    const qty = px > 0 ? Number((sizing.notional / px).toFixed(8)) : 0;

    if (!(qty > 0)) {
      const memory = await persistDecision('SIZING_REJECTED', { risk, intraday, execution });
      actions.push({ type: 'risk_reject', reason: 'Could not calculate a valid order quantity' });
      return res.status(200).json({ ok: true, mode: 'PAPER', enabled, memory, actions });
    }

    const entryLimitPrice = priceRound(px * (1 + ENTRY_LIMIT_CUSHION_PCT));
    const stopPrice = priceRound(px * (1 - sizing.stop_pct));
    const takeProfitPrice = priceRound(px * (1 + sizing.take_profit_pct));
    const refCents = Math.max(1, Math.round(px * 100));
    const clientId = `aitr-${source === 'LLM' ? 'g' : 'q'}-${pick.symbol.toLowerCase()}-s${pick.score}-c${Math.round(decision.confidence)}-p${refCents}-${String(Date.now()).slice(-7)}`.slice(0,48);

    const planned = {
      type: enabled ? 'entry' : 'entry_dry_run',
      decision_source: source,
      symbol: pick.symbol,
      score: pick.score,
      decision_confidence: decision.confidence,
      notional: sizing.notional,
      qty,
      reference_price: px,
      entry_limit_price: Number(entryLimitPrice),
      execution_policy: 'PRICE_CAPPED_LIMIT_BRACKET',
      execution_spread_pct: execution.spread_pct,
      execution_quote_age_seconds: execution.age_seconds,
      intraday_confirmation: intraday,
      stop_price: Number(stopPrice),
      take_profit_price: Number(takeProfitPrice),
      client_order_id: clientId
    };

    let memory;
    if (!enabled) {
      logTraderEvent('entry_dry_run', planned);
      actions.push(planned);
      memory = await persistDecision('ENTRY_DRY_RUN', { risk, intraday, execution: planned });
    } else {
      const orderRes = await fetch(`${baseUrl}/v2/orders`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          symbol: pick.symbol,
          qty: qty.toString(),
          side: 'buy',
          type: 'limit',
          limit_price: entryLimitPrice,
          time_in_force: 'day',
          order_class: 'bracket',
          take_profit: { limit_price: takeProfitPrice },
          stop_loss: { stop_price: stopPrice },
          client_order_id: clientId
        })
      });
      const order = await orderRes.json();

      logTraderEvent('entry_submit', { ...planned, submitted: orderRes.ok, order_id: order?.id || null, status: order?.status || null, error: orderRes.ok ? null : order?.message || 'Bracket order rejected' });
      const submittedAction = {
        ...planned,
        submitted: orderRes.ok,
        order_id: order?.id || null,
        status: order?.status || null,
        error: orderRes.ok ? null : order?.message || 'Bracket order rejected'
      };
      actions.push(submittedAction);
      memory = await persistDecision(orderRes.ok ? 'ENTRY_SUBMITTED' : 'ORDER_REJECTED', {
        risk,
        intraday,
        execution: submittedAction
      });
    }

    return res.status(200).json({
      ok: true,
      mode: 'PAPER',
      enabled,
      regime: scan.regime,
      market_phase: entryWindow.phase,
      portfolio_risk: portfolioRisk,
      account_risk: accountRisk,
      memory,
      rules: {
        regime_entry_threshold: entryThreshold,
        daily_loss_stop_pct: -0.02,
        max_exposure_pct: 0.30,
        max_positions: 3,
        max_entry_dollars_during_calibration: 25,
        max_autonomous_entries_per_day: MAX_AUTONOMOUS_ENTRIES_PER_DAY,
        symbol_cooldown_days: SYMBOL_COOLDOWN_DAYS,
        entry_timeout_minutes: ENTRY_TIMEOUT_MINUTES,
        entry_limit_cushion_pct: ENTRY_LIMIT_CUSHION_PCT
      },
      actions
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Automation cycle failed' });
  }
}
