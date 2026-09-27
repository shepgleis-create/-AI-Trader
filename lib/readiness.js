function clamp(n,min,max){return Math.max(min,Math.min(max,n));}

export function candidateReadiness(candidate, regime = {}, context = {}) {
  let score = 50;
  const positives = [];
  const negatives = [];

  const scanner = Number(candidate?.score || 0);
  if (scanner >= 95) { score += 18; positives.push('Elite scanner score'); }
  else if (scanner >= 90) { score += 14; positives.push('Very strong scanner score'); }
  else if (scanner >= 84) { score += 9; positives.push('Strong scanner score'); }
  else if (scanner >= 78) { score += 4; }
  else { score -= 8; negatives.push('Weak scanner score'); }

  const breadth = Number(regime?.breadth?.advance_ratio);
  if (Number.isFinite(breadth)) {
    if (breadth >= 0.62) { score += 6; positives.push('Strong market breadth'); }
    else if (breadth <= 0.38) { score -= 8; negatives.push('Weak market breadth'); }
  }

  if (regime?.label === 'RISK_ON') score += 5;
  else if (regime?.label === 'RISK_OFF') { score -= 8; negatives.push('Risk-off market regime'); }

  const participation=regime?.participation||{};
  if (participation.label === 'BROAD') {
    score += 6;
    positives.push('Broad multi-day market participation');
  } else if (participation.label === 'THIN') {
    score -= 9;
    negatives.push('Thin multi-day market participation');
  }

  const sectorStrength=Number(candidate?.sector_strength_percentile);
  if (Number.isFinite(sectorStrength) && Number(candidate?.sector_correlation || 0) >= 0.55) {
    if (sectorStrength >= 0.80) {
      score += 6;
      positives.push('Leading sector backdrop');
    } else if (sectorStrength <= 0.20) {
      score -= 6;
      negatives.push('Lagging sector backdrop');
    }
  }

  const rs = Number(candidate?.rs_percentile);
  if (Number.isFinite(rs)) {
    if (rs >= 0.90) { score += 9; positives.push('Top-decile relative strength'); }
    else if (rs >= 0.75) score += 5;
    else if (rs < 0.50) { score -= 8; negatives.push('Below-median relative strength'); }
  }

  const spread = candidate?.spread_pct == null ? null : Number(candidate.spread_pct);
  if (spread != null) {
    if (spread <= 0.0015) { score += 5; positives.push('Tight bid/ask spread'); }
    else if (spread > 0.005) { score -= 12; negatives.push('Wide bid/ask spread'); }
  }

  const beta = Number(candidate?.beta_60d);
  if (Number.isFinite(beta)) {
    if (beta <= 1.4) score += 3;
    else if (beta > 2.75) { score -= 12; negatives.push('Very high market beta'); }
    else if (beta > 2.0) score -= 5;
  }

  const gap = Number(candidate?.gap_pct || 0);
  const fromOpen = Number(candidate?.move_from_open_pct || 0);
  if (Math.abs(gap) >= 0.10) {
    score -= 12;
    negatives.push('Extreme overnight gap');
  } else if (gap >= 0.06 && fromOpen <= -0.015) {
    score -= 10;
    negatives.push('Gap-up is fading after open');
  } else if (gap >= 0.02 && fromOpen > 0) {
    score += 3;
    positives.push('Gap holding after open');
  }

  const event = context?.risk || {};
  if (event.hard_block) {
    score -= 30;
    negatives.push('Hard event-risk block');
  } else if (event.level === 'HIGH') {
    score -= 18;
    negatives.push('High event risk');
  } else if (event.level === 'MEDIUM') {
    score -= 6;
    negatives.push('Medium event risk');
  } else {
    score += 2;
  }

  const edge = candidate?.historical_edge;
  if (edge?.samples >= 8) {
    if (Number(edge.avg_5d_return) > 0.01 && Number(edge.win_rate) >= 0.55) {
      score += 7;
      positives.push('Favorable same-symbol analogs');
    } else if (Number(edge.avg_5d_return) <= -0.005 && Number(edge.win_rate) < 0.40) {
      score -= 10;
      negatives.push('Unfavorable same-symbol analogs');
    }
  }

  const liquidity = Number(candidate?.avg_dollar_volume_20d || 0);
  if (liquidity >= 100_000_000) score += 4;
  else if (liquidity < 5_000_000) {
    score -= 10;
    negatives.push('Low average dollar liquidity');
  }

  const atr = Number(candidate?.atr_pct || 0);
  if (atr > 0.10) {
    score -= 10;
    negatives.push('ATR risk too high');
  } else if (atr > 0 && atr <= 0.04) {
    score += 3;
  }

  score = clamp(Math.round(score),0,100);
  let grade='C';
  if(score>=90) grade='A+';
  else if(score>=82) grade='A';
  else if(score>=74) grade='B';
  else if(score>=64) grade='C';
  else if(score>=50) grade='D';
  else grade='F';

  return {
    score,
    grade,
    positives: positives.slice(0,5),
    negatives: negatives.slice(0,5),
    diagnostic_only: true
  };
}
