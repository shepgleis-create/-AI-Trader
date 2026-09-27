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

export function evaluateEntry({
  account,
  positions,
  candidate,
  regime,
  eventContext,
  confidence
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
  if (Number(candidate?.avg_dollar_volume_20d || 0) < 5_000_000) {
    reasons.push('Insufficient average dollar liquidity');
  }
  if (Number(candidate?.atr_pct || 0) > 0.10) reasons.push('ATR risk too high');
  if (Number(candidate?.volatility_20d || 0) > 1.20) reasons.push('Realized volatility too high');

  return {
    approved: reasons.length === 0,
    reasons,
    threshold,
    portfolio,
    sizing: candidate ? sizePosition(account, candidate, portfolio) : null
  };
}

export const RISK_DEFAULTS = DEFAULTS;
