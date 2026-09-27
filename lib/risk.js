const DEFAULTS = {
  maxPositions: 3,
  maxExposurePct: 0.30,
  dailyLossStopPct: -0.02,
  maxEntryDollars: 25,
  riskPerTradePct: 0.0025
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function getPortfolioRisk(account, positions = []) {
  const equity = Number(account?.equity || account?.portfolio_value || 0);
  const lastEquity = Number(account?.last_equity || 0);
  const dayReturn = lastEquity > 0 ? (equity - lastEquity) / lastEquity : 0;
  const grossExposure = positions.reduce((s,p) => s + Math.abs(Number(p.market_value || 0)), 0);
  const exposurePct = equity > 0 ? grossExposure / equity : 0;

  return {
    equity,
    last_equity: lastEquity,
    day_return: dayReturn,
    gross_exposure: grossExposure,
    exposure_pct: exposurePct,
    daily_loss_lock: dayReturn <= DEFAULTS.dailyLossStopPct,
    exposure_lock: exposurePct >= DEFAULTS.maxExposurePct,
    position_lock: positions.length >= DEFAULTS.maxPositions
  };
}

export function entryThresholdForRegime(regimeLabel) {
  if (regimeLabel === 'RISK_OFF') return 90;
  if (regimeLabel === 'NEUTRAL') return 84;
  return 82;
}

export function sizePosition(account, candidate, portfolioRisk = {}) {
  const equity = Number(account?.equity || account?.portfolio_value || 0);
  const cash = Number(account?.cash || 0);
  const atr = Number(candidate?.atr_pct || 0.03);

  // Risk-budget sizing, still capped very small during paper calibration.
  const stopPct = clamp(atr * 2, 0.025, 0.06);
  const riskBudget = Math.max(1, equity * DEFAULTS.riskPerTradePct);
  let notional = riskBudget / stopPct;

  const vol = Number(candidate?.volatility_20d || 0);
  if (vol > 0.70) notional *= 0.55;
  else if (vol > 0.50) notional *= 0.75;

  const beta = Number(candidate?.beta_60d);
  if (Number.isFinite(beta)) {
    if (beta > 2.0) notional *= 0.60;
    else if (beta > 1.5) notional *= 0.80;
  }

  notional = Math.min(notional, DEFAULTS.maxEntryDollars, cash);
  notional = Math.max(1, Math.floor(notional * 100) / 100);

  const takeProfitPct = clamp(stopPct * 2, 0.05, 0.12);

  return {
    notional,
    stop_pct: stopPct,
    take_profit_pct: takeProfitPct,
    estimated_qty: Number(candidate?.price || 0) > 0
      ? Number((notional / Number(candidate.price)).toFixed(8))
      : 0
  };
}

function returnsFromBars(bars) {
  const out = [];
  const rows = Array.isArray(bars) ? bars : [];
  for (let i = 1; i < rows.length; i++) {
    const a = Number(rows[i - 1]?.c);
    const b = Number(rows[i]?.c);
    const t = String(rows[i]?.t || '').slice(0,10);
    if (a > 0 && b > 0 && t) out.push({ t, r: b / a - 1 });
  }
  return out;
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 20) return null;
  const ax = xs.slice(-n), ay = ys.slice(-n);
  const mx = ax.reduce((a,b)=>a+b,0)/n;
  const my = ay.reduce((a,b)=>a+b,0)/n;
  let num=0, dx=0, dy=0;
  for (let i=0;i<n;i++) {
    const vx=ax[i]-mx, vy=ay[i]-my;
    num += vx*vy; dx += vx*vx; dy += vy*vy;
  }
  if (dx<=0 || dy<=0) return null;
  return num / Math.sqrt(dx*dy);
}

export function maxPortfolioCorrelation(candidateBars, heldBarsBySymbol = {}) {
  const candidate = returnsFromBars(candidateBars);
  const candidateMap = new Map(candidate.map(x => [x.t, x.r]));
  let best = { symbol: null, correlation: null, overlap: 0 };

  for (const [symbol, bars] of Object.entries(heldBarsBySymbol || {})) {
    const held = returnsFromBars(bars);
    const xs = [], ys = [];
    for (const row of held) {
      if (candidateMap.has(row.t)) {
        xs.push(candidateMap.get(row.t));
        ys.push(row.r);
      }
    }
    const correlation = pearson(xs, ys);
    if (correlation == null) continue;
    if (best.correlation == null || correlation > best.correlation) {
      best = { symbol, correlation, overlap: xs.length };
    }
  }
  return best;
}

export function evaluateEntry({
  account,
  positions,
  candidate,
  regime,
  eventContext,
  confidence,
  portfolioCorrelation
}) {
  const portfolio = getPortfolioRisk(account, positions);
  const threshold = entryThresholdForRegime(regime?.label);
  const reasons = [];

  if (portfolio.daily_loss_lock) reasons.push('Daily loss kill switch is active');
  if (portfolio.exposure_lock) reasons.push('Portfolio exposure cap is reached');
  if (portfolio.position_lock) reasons.push('Maximum open positions reached');
  if (!candidate || Number(candidate.score) < threshold) {
    reasons.push('Scanner score below regime-adjusted entry threshold');
  }
  if (Number(confidence || 0) < 60) reasons.push('Model conviction below minimum');
  if (eventContext?.risk?.hard_block) reasons.push('Hard event-risk block');

  const breadth = Number(regime?.breadth?.advance_ratio);
  if (
    regime?.label === 'RISK_OFF' &&
    Number.isFinite(breadth) &&
    breadth <= 0.35
  ) {
    reasons.push('Long-only market stress lock: risk-off regime with very weak breadth');
  }

  if (Number(regime?.volatility || 0) >= 0.40) {
    reasons.push('Market volatility stress lock');
  }

  if (Number(candidate?.day_change || 0) >= 0.08) {
    reasons.push('Chase protection: candidate already extended more than 8% today');
  }

  if (
    Number(candidate?.rsi14 || 0) >= 75 &&
    Number(candidate?.day_change || 0) >= 0.04
  ) {
    reasons.push('Chase protection: extended RSI plus strong same-day move');
  }

  if (Number(candidate?.beta_60d) > 2.75) {
    reasons.push('Market beta is too high for calibration risk');
  }

  if (
    Number(candidate?.gap_pct || 0) >= 0.06 &&
    Number(candidate?.move_from_open_pct || 0) <= -0.015
  ) {
    reasons.push('Gap-fade protection: large gap up is failing after the open');
  }

  if (Math.abs(Number(candidate?.gap_pct || 0)) >= 0.10) {
    reasons.push('Extreme overnight gap risk');
  }
  if (Number(candidate?.avg_dollar_volume_20d || 0) < 5_000_000) {
    reasons.push('Insufficient average dollar liquidity');
  }
  if (Number(candidate?.atr_pct || 0) > 0.10) reasons.push('ATR risk too high');
  if (Number(candidate?.volatility_20d || 0) > 1.20) reasons.push('Realized volatility too high');
  if (candidate?.spread_pct != null && Number(candidate.spread_pct) > 0.005) {
    reasons.push('Bid/ask spread is too wide');
  }
  if (candidate?.data_age_seconds != null && Number(candidate.data_age_seconds) > 900) {
    reasons.push('Market snapshot is stale');
  }
  if (candidate?.rs_percentile != null && Number(candidate.rs_percentile) < 0.50) {
    reasons.push('Cross-sectional relative strength is below median');
  }
  const edge = candidate?.historical_edge;
  if (
    edge?.samples >= 8 &&
    Number(edge.avg_5d_return) <= -0.005 &&
    Number(edge.win_rate) < 0.40
  ) {
    reasons.push('Same-symbol historical analogs are materially unfavorable');
  }
  if (
    portfolioCorrelation?.correlation != null &&
    portfolioCorrelation.overlap >= 20 &&
    Number(portfolioCorrelation.correlation) >= 0.85
  ) {
    reasons.push('Candidate is too highly correlated with an existing position');
  }

  return {
    approved: reasons.length === 0,
    reasons,
    threshold,
    portfolio,
    sizing: candidate ? sizePosition(account, candidate, portfolio) : null,
    portfolio_correlation: portfolioCorrelation || null
  };
}

export const RISK_DEFAULTS = DEFAULTS;
