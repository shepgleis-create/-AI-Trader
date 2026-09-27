import { requireDashboardAuth } from '../lib/auth.js';
import { fetchMarketScan, fetchBarsForSymbols, analyze, detectMarketRegime } from '../lib/strategy.js';
import { entryThresholdForRegime } from '../lib/risk.js';

const STARTING_CAPITAL = 10000;
const MAX_POSITIONS = 3;
const UNIVERSE_SIZE = 40;
const SLIPPAGE = 0.0005;
const MAX_HOLD_DAYS = 20;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function calcStd(values) {
  if (!values.length) return 0;
  const mean = values.reduce((a,b) => a+b,0) / values.length;
  return Math.sqrt(values.reduce((s,v) => s + (v-mean) ** 2, 0) / values.length);
}

function dateKey(bar) {
  return String(bar?.t || '').slice(0,10);
}

export default async function handler(req, res) {
  if (!requireDashboardAuth(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  const baseUrl = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';

  if (!key || !secret) return res.status(500).json({ error: 'Missing Alpaca credentials' });
  if (!baseUrl.includes('paper-api.alpaca.markets')) {
    return res.status(403).json({ error: 'Backtest is available only in the paper-trading build.' });
  }

  try {
    const scan = await fetchMarketScan(key, secret);
    const symbols = scan.candidates.slice(0, UNIVERSE_SIZE).map(c => c.symbol);
    const requested = [...new Set([...symbols, 'SPY'])];
    const barsBySymbol = await fetchBarsForSymbols(requested, key, secret, 470);
    const spyBars = barsBySymbol.SPY || [];

    if (spyBars.length < 180) {
      return res.status(422).json({ error: 'Not enough SPY history for backtest.' });
    }

    const barMaps = {};
    for (const symbol of symbols) {
      barMaps[symbol] = new Map((barsBySymbol[symbol] || []).map(b => [dateKey(b), b]));
    }

    let cash = STARTING_CAPITAL;
    const positions = new Map();
    const trades = [];
    const equityCurve = [];
    const dailyReturns = [];
    let previousEquity = STARTING_CAPITAL;

    const startIndex = Math.max(60, spyBars.length - 252);

    for (let i = startIndex; i < spyBars.length; i++) {
      const today = spyBars[i];
      const day = dateKey(today);

      // Manage existing positions using today's bar. Conservative assumption:
      // if both stop and target are touched in one daily bar, stop is counted first.
      for (const [symbol, p] of [...positions.entries()]) {
        const bar = barMaps[symbol]?.get(day);
        if (!bar) {
          p.daysHeld++;
          continue;
        }

        const low = Number(bar.l);
        const high = Number(bar.h);
        const close = Number(bar.c);
        let exitPrice = null;
        let reason = null;

        if (low <= p.stopPrice) {
          exitPrice = p.stopPrice * (1 - SLIPPAGE);
          reason = 'stop';
        } else if (high >= p.targetPrice) {
          exitPrice = p.targetPrice * (1 - SLIPPAGE);
          reason = 'target';
        } else if (p.daysHeld >= MAX_HOLD_DAYS) {
          exitPrice = close * (1 - SLIPPAGE);
          reason = 'time';
        }

        if (exitPrice != null) {
          const proceeds = p.qty * exitPrice;
          cash += proceeds;
          const pnl = proceeds - p.cost;
          trades.push({
            symbol,
            entry_date: p.entryDate,
            exit_date: day,
            entry_price: p.entryPrice,
            exit_price: exitPrice,
            pnl,
            return_pct: p.cost > 0 ? pnl / p.cost : 0,
            reason,
            score: p.score,
            regime: p.regime
          });
          positions.delete(symbol);
        } else {
          p.daysHeld++;
        }
      }

      // Signals are built from data available through the previous close,
      // then entered at today's open to avoid look-ahead.
      if (positions.size < MAX_POSITIONS && i > 60) {
        const spyHistory = spyBars.slice(0, i);
        const regime = detectMarketRegime(spyHistory);
        const threshold = entryThresholdForRegime(regime.label);
        const benchmark20 = Number(regime.spy_20d || 0);
        const scored = [];

        for (const symbol of symbols) {
          if (positions.has(symbol)) continue;
          const all = barsBySymbol[symbol] || [];
          const history = all.filter(b => dateKey(b) < day);
          const candidate = analyze(symbol, history, {
            benchmark20,
            regimeAdjustment: regime.score_adjustment
          });
          if (!candidate || candidate.score < threshold) continue;

          const todayBar = barMaps[symbol]?.get(day);
          if (!todayBar) continue;

          scored.push({ candidate, todayBar, regime });
        }

        scored.sort((a,b) => b.candidate.score - a.candidate.score);

        for (const item of scored) {
          if (positions.size >= MAX_POSITIONS) break;
          const symbol = item.candidate.symbol;
          const open = Number(item.todayBar.o);
          if (!(open > 0)) continue;

          const equityEstimate = cash + [...positions.values()].reduce((s,p) => {
            const bar = barMaps[p.symbol]?.get(day);
            return s + p.qty * Number(bar?.c || p.entryPrice);
          }, 0);

          const allocation = Math.min(cash, equityEstimate * 0.10);
          if (allocation < 50) break;

          const entryPrice = open * (1 + SLIPPAGE);
          const qty = allocation / entryPrice;
          const cost = qty * entryPrice;
          const stopPct = clamp(Number(item.candidate.atr_pct || 0.03) * 2, 0.025, 0.06);
          const targetPct = clamp(stopPct * 2, 0.05, 0.12);

          cash -= cost;
          positions.set(symbol, {
            symbol,
            qty,
            cost,
            entryPrice,
            entryDate: day,
            stopPrice: entryPrice * (1 - stopPct),
            targetPrice: entryPrice * (1 + targetPct),
            daysHeld: 0,
            score: item.candidate.score,
            regime: item.regime.label
          });
        }
      }

      let equity = cash;
      for (const p of positions.values()) {
        const bar = barMaps[p.symbol]?.get(day);
        equity += p.qty * Number(bar?.c || p.entryPrice);
      }

      equityCurve.push({ date: day, equity });
      if (previousEquity > 0) dailyReturns.push((equity / previousEquity) - 1);
      previousEquity = equity;
    }

    // Liquidate remaining positions at last close for comparable ending value.
    const lastDay = dateKey(spyBars.at(-1));
    for (const [symbol, p] of [...positions.entries()]) {
      const bar = barMaps[symbol]?.get(lastDay);
      const exitPrice = Number(bar?.c || p.entryPrice) * (1 - SLIPPAGE);
      const proceeds = p.qty * exitPrice;
      cash += proceeds;
      const pnl = proceeds - p.cost;
      trades.push({
        symbol,
        entry_date: p.entryDate,
        exit_date: lastDay,
        entry_price: p.entryPrice,
        exit_price: exitPrice,
        pnl,
        return_pct: p.cost > 0 ? pnl / p.cost : 0,
        reason: 'end_of_test',
        score: p.score,
        regime: p.regime
      });
      positions.delete(symbol);
    }

    const endingEquity = cash;
    const totalReturn = endingEquity / STARTING_CAPITAL - 1;
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl < 0);
    const grossProfit = wins.reduce((s,t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s,t) => s + t.pnl, 0));

    let peak = STARTING_CAPITAL;
    let maxDrawdown = 0;
    for (const p of equityCurve) {
      peak = Math.max(peak, p.equity);
      maxDrawdown = Math.min(maxDrawdown, p.equity / peak - 1);
    }

    const avgDaily = dailyReturns.length
      ? dailyReturns.reduce((a,b) => a+b,0) / dailyReturns.length
      : 0;
    const dailyStd = calcStd(dailyReturns);
    const sharpe = dailyStd > 0 ? (avgDaily / dailyStd) * Math.sqrt(252) : 0;

    const spyStart = Number(spyBars[startIndex]?.o || spyBars[startIndex]?.c || 0);
    const spyEnd = Number(spyBars.at(-1)?.c || 0);
    const spyReturn = spyStart > 0 ? spyEnd / spyStart - 1 : 0;

    return res.status(200).json({
      label: 'Current-universe walk-forward research test',
      warning: 'Uses today’s active/liquid universe, so survivorship and selection bias remain. Daily bars also cannot determine intraday order sequence perfectly.',
      period: {
        start: dateKey(spyBars[startIndex]),
        end: lastDay,
        trading_days: spyBars.length - startIndex
      },
      universe: {
        market_universe: scan.universe_size,
        deep_scan: scan.deep_scan_size,
        backtested_symbols: symbols.length
      },
      assumptions: {
        starting_capital: STARTING_CAPITAL,
        max_positions: MAX_POSITIONS,
        allocation_per_position_pct: 0.10,
        slippage_each_side_pct: SLIPPAGE,
        max_hold_days: MAX_HOLD_DAYS
      },
      metrics: {
        ending_equity: endingEquity,
        total_return: totalReturn,
        spy_return: spyReturn,
        excess_return_vs_spy: totalReturn - spyReturn,
        trades: trades.length,
        win_rate: trades.length ? wins.length / trades.length : 0,
        avg_trade_return: trades.length ? trades.reduce((s,t) => s + t.return_pct,0) / trades.length : 0,
        profit_factor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0,
        max_drawdown: maxDrawdown,
        sharpe
      },
      recent_trades: trades.slice(-12).reverse()
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Backtest failed' });
  }
}
