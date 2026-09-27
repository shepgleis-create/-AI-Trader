const EXCHANGES = new Set(['NASDAQ','NYSE','ARCA','BATS','AMEX','NYSEARCA']);
const SNAPSHOT_BATCH = 300;
const HISTORY_BATCH = 75;
const DEEP_SCAN_LIMIT = 300;
const MARKET_SCAN_CACHE_MS = 90_000;
export const SECTOR_ETFS = ['XLK','XLF','XLE','XLV','XLY','XLP','XLI','XLB','XLRE','XLC','XLU'];

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a,b) => a + b, 0) / period;
}

function std(values) {
  if (!values.length) return 0;
  const mean = values.reduce((a,b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((s,v) => s + (v - mean) ** 2, 0) / values.length);
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  const slice = values.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function pctChange(a, b) {
  if (!a || !b) return 0;
  return (b - a) / a;
}

function percentileRanks(rows, field) {
  const sorted = rows
    .map(x => ({ symbol: x.symbol, value: Number(x[field]) }))
    .filter(x => Number.isFinite(x.value))
    .sort((a,b) => a.value - b.value);

  const out = new Map();
  const denom = Math.max(1, sorted.length - 1);
  sorted.forEach((x, i) => out.set(x.symbol, i / denom));
  return out;
}

function atrPct(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const slice = bars.slice(-(period + 1));
  const tr = [];
  for (let i = 1; i < slice.length; i++) {
    const h = Number(slice[i].h);
    const l = Number(slice[i].l);
    const prev = Number(slice[i - 1].c);
    tr.push(Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev)));
  }
  const atr = tr.slice(-period).reduce((a,b) => a + b, 0) / period;
  const price = Number(slice.at(-1).c);
  return price > 0 ? atr / price : null;
}

function realizedVol(closes, period = 20) {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  const returns = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1] > 0) returns.push((slice[i] / slice[i - 1]) - 1);
  }
  return std(returns) * Math.sqrt(252);
}

function returnSeries(bars, maxPoints = 60) {
  const rows = Array.isArray(bars) ? bars : [];
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const a = Number(rows[i - 1]?.c);
    const b = Number(rows[i]?.c);
    const t = String(rows[i]?.t || '').slice(0,10);
    if (a > 0 && b > 0 && t) out.push({ t, r: b / a - 1 });
  }
  return out.slice(-maxPoints);
}

function alignedReturnPairs(aBars, bBars, maxPoints = 60) {
  const a = returnSeries(aBars, maxPoints);
  const b = new Map(returnSeries(bBars, maxPoints).map(x => [x.t, x.r]));
  const xs = [], ys = [];
  for (const row of a) {
    if (!b.has(row.t)) continue;
    xs.push(row.r);
    ys.push(b.get(row.t));
  }
  return { xs, ys };
}

function correlation(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 20) return null;
  const ax = xs.slice(-n), ay = ys.slice(-n);
  const mx = ax.reduce((a,b)=>a+b,0)/n;
  const my = ay.reduce((a,b)=>a+b,0)/n;
  let num=0, dx=0, dy=0;
  for (let i=0;i<n;i++) {
    const vx=ax[i]-mx, vy=ay[i]-my;
    num += vx*vy;
    dx += vx*vx;
    dy += vy*vy;
  }
  if (dx<=0 || dy<=0) return null;
  return num / Math.sqrt(dx*dy);
}

function betaToBenchmark(assetBars, benchmarkBars) {
  const { xs, ys } = alignedReturnPairs(assetBars, benchmarkBars, 60);
  const n = Math.min(xs.length, ys.length);
  if (n < 20) return null;
  const mx = xs.reduce((a,b)=>a+b,0)/n;
  const my = ys.reduce((a,b)=>a+b,0)/n;
  let cov=0, variance=0;
  for (let i=0;i<n;i++) {
    cov += (xs[i]-mx)*(ys[i]-my);
    variance += (ys[i]-my)*(ys[i]-my);
  }
  if (variance<=0) return null;
  return cov/variance;
}

export function inferSectorProxy(assetBars, barsBySymbol = {}) {
  let best = { symbol:null, correlation:null };
  for (const sector of SECTOR_ETFS) {
    const bars = barsBySymbol[sector] || [];
    const { xs, ys } = alignedReturnPairs(assetBars, bars, 60);
    const corr = correlation(xs, ys);
    if (corr == null) continue;
    if (best.correlation == null || corr > best.correlation) {
      best = { symbol:sector, correlation:corr };
    }
  }
  return best;
}

export function marketRiskMetrics(assetBars, barsBySymbol = {}) {
  const sector = inferSectorProxy(assetBars, barsBySymbol);
  return {
    beta_60d: betaToBenchmark(assetBars, barsBySymbol.SPY || []),
    sector_proxy: sector.symbol,
    sector_correlation: sector.correlation
  };
}

function classifyHistoricalSetup(bars, endIndex) {
  const slice = bars.slice(0, endIndex + 1);
  if (slice.length < 55) return null;

  const closes = slice.map(b => Number(b.c)).filter(Number.isFinite);
  const volumes = slice.map(b => Number(b.v)).filter(Number.isFinite);
  if (closes.length < 55) return null;

  const price = closes.at(-1);
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const r = rsi(closes, 14);
  const mom5 = pctChange(closes.at(-6), price);
  const mom20 = pctChange(closes.at(-21), price);
  const high20 = Math.max(...closes.slice(-20));
  const avgVol20 = sma(volumes, 20);
  const volumeRatio = avgVol20 ? (volumes.at(-1) || 0) / avgVol20 : 1;
  const distanceFromHigh = high20 > 0 ? (high20 - price) / high20 : 1;

  if (distanceFromHigh <= 0.015 && volumeRatio >= 1.15 && mom5 > 0) return 'BREAKOUT';
  if (price > s50 && price <= s20 * 1.015 && r >= 42 && r <= 60) return 'PULLBACK';
  if (price > s20 && s20 > s50 && mom20 > 0 && mom5 > 0) return 'TREND_CONTINUATION';
  if (mom20 > 0.10) return 'MOMENTUM';
  return 'TREND';
}

function historicalAnalogEdge(bars, setupType) {
  if (!Array.isArray(bars) || bars.length < 70 || !setupType) {
    return { samples: 0, win_rate: null, avg_5d_return: null, median_5d_return: null };
  }

  const returns = [];
  for (let i = 55; i < bars.length - 5; i++) {
    if (classifyHistoricalSetup(bars, i) !== setupType) continue;
    const entry = Number(bars[i]?.c);
    const exit = Number(bars[i + 5]?.c);
    if (!(entry > 0 && exit > 0)) continue;
    returns.push(exit / entry - 1);
  }

  const recent = returns.slice(-30);
  if (!recent.length) {
    return { samples: 0, win_rate: null, avg_5d_return: null, median_5d_return: null };
  }

  const sorted = [...recent].sort((a,b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;

  return {
    samples: recent.length,
    win_rate: recent.filter(x => x > 0).length / recent.length,
    avg_5d_return: recent.reduce((a,b) => a + b, 0) / recent.length,
    median_5d_return: median
  };
}

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapConcurrent(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function dataFetch(url,options={},attempts=4){
  let last=null;
  for(let i=0;i<attempts;i++){
    last=await fetch(url,options);
    if(last.status!==429&&last.status<500)return last;
    if(i<attempts-1){
      const retryAfter=Number(last.headers.get('retry-after')||0);
      await sleep(retryAfter>0?retryAfter*1000:450*(i+1));
    }
  }
  return last;
}

export function detectMarketRegime(spyBars) {
  const closes = (spyBars || []).map(b => Number(b.c)).filter(Number.isFinite);
  if (closes.length < 55) {
    return { label: 'UNKNOWN', score_adjustment: 0, spy_20d: 0, volatility: null };
  }
  const price = closes.at(-1);
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const mom20 = pctChange(closes.at(-21), price);
  const vol = realizedVol(closes, 20);

  let label = 'NEUTRAL';
  let scoreAdjustment = 0;
  if (price > s50 && s20 > s50 && mom20 > 0) {
    label = 'RISK_ON';
    scoreAdjustment = 4;
  } else if (price < s50 && s20 < s50 && mom20 < 0) {
    label = 'RISK_OFF';
    scoreAdjustment = -8;
  }

  return {
    label,
    score_adjustment: scoreAdjustment,
    spy_price: price,
    spy_20d: mom20,
    volatility: vol,
    sma20: s20,
    sma50: s50
  };
}

export function analyze(symbol, bars, context = {}) {
  const closes = bars.map(b => Number(b.c)).filter(Number.isFinite);
  const volumes = bars.map(b => Number(b.v)).filter(Number.isFinite);
  if (closes.length < 55) return null;

  const price = closes.at(-1);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const rsi14 = rsi(closes, 14);
  const mom20 = pctChange(closes.at(-21), price);
  const mom5 = pctChange(closes.at(-6), price);
  const high20 = Math.max(...closes.slice(-20));
  const avgVol20 = sma(volumes, 20);
  const lastVol = volumes.at(-1) || 0;
  const volumeRatio = avgVol20 ? lastVol / avgVol20 : 1;
  const atr14Pct = atrPct(bars, 14);
  const vol20 = realizedVol(closes, 20);
  const avgDollarVolume20 = avgVol20 ? avgVol20 * price : 0;
  const benchmark20 = Number(context?.benchmark20 || 0);
  const relativeStrength20 = mom20 - benchmark20;

  let score = 50 + Number(context?.regimeAdjustment || 0);
  const reasons = [];

  if (price > sma20) { score += 10; reasons.push('Price above 20-day trend'); } else score -= 10;
  if (sma20 > sma50) { score += 14; reasons.push('20-day trend above 50-day trend'); } else score -= 12;

  if (mom20 > 0.08) { score += 12; reasons.push('Strong 20-day momentum'); }
  else if (mom20 > 0.02) { score += 6; reasons.push('Positive 20-day momentum'); }
  else if (mom20 < -0.08) score -= 12;
  else if (mom20 < 0) score -= 5;

  if (mom5 > 0) { score += 4; reasons.push('Positive 5-day momentum'); } else score -= 3;

  if (rsi14 >= 48 && rsi14 <= 68) { score += 8; reasons.push('RSI in constructive range'); }
  else if (rsi14 > 78) { score -= 10; reasons.push('RSI extended'); }
  else if (rsi14 < 35) { score -= 7; reasons.push('RSI weak'); }

  const distanceFromHigh = (high20 - price) / high20;
  const riskAdjustedMomentum = atr14Pct && atr14Pct > 0 ? mom20 / atr14Pct : 0;

  if (distanceFromHigh <= 0.02) { score += 6; reasons.push('Near 20-day high'); }
  if (volumeRatio >= 1.25) { score += 6; reasons.push('Volume expansion'); }
  if (riskAdjustedMomentum >= 3) { score += 5; reasons.push('Strong risk-adjusted momentum'); }
  else if (riskAdjustedMomentum < -1) score -= 4;

  if (relativeStrength20 >= 0.05) { score += 8; reasons.push('Outperforming SPY'); }
  else if (relativeStrength20 > 0) score += 4;
  else if (relativeStrength20 <= -0.05) score -= 8;

  if (avgDollarVolume20 >= 50_000_000) score += 4;
  else if (avgDollarVolume20 < 5_000_000) score -= 6;

  if (vol20 != null && vol20 > 0.9) score -= 8;
  if (atr14Pct != null && atr14Pct > 0.08) score -= 8;

  score = Math.max(0, Math.min(100, Math.round(score)));

  let setup = 'WATCH';
  if (score >= 82) setup = 'STRONG';
  else if (score >= 68) setup = 'GOOD';
  else if (score < 45) setup = 'WEAK';

  let setupType = 'TREND';
  if (distanceFromHigh <= 0.015 && volumeRatio >= 1.15 && mom5 > 0) {
    setupType = 'BREAKOUT';
  } else if (price > sma50 && price <= sma20 * 1.015 && rsi14 >= 42 && rsi14 <= 60) {
    setupType = 'PULLBACK';
  } else if (price > sma20 && sma20 > sma50 && mom20 > 0 && mom5 > 0) {
    setupType = 'TREND_CONTINUATION';
  } else if (mom20 > 0.10 && relativeStrength20 > 0.04) {
    setupType = 'MOMENTUM';
  }

  return {
    symbol,
    score,
    setup,
    price,
    sma20,
    sma50,
    rsi14,
    atr_pct: atr14Pct,
    volatility_20d: vol20,
    avg_dollar_volume_20d: avgDollarVolume20,
    relative_strength_20d: relativeStrength20,
    risk_adjusted_momentum: riskAdjustedMomentum,
    setup_type: setupType,
    momentum_5d: mom5,
    momentum_20d: mom20,
    volume_ratio: volumeRatio,
    reasons: reasons.slice(0, 6)
  };
}

async function fetchAssets(key, secret) {
  const url = 'https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity';
  const r = await dataFetch(url, {
    headers: {
      'APCA-API-KEY-ID': key,
      'APCA-API-SECRET-KEY': secret
    }
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.message || 'Could not load U.S. asset universe');

  return (Array.isArray(data) ? data : []).filter(a =>
    a?.status === 'active' &&
    a?.tradable === true &&
    EXCHANGES.has(String(a?.exchange || '').toUpperCase()) &&
    typeof a?.symbol === 'string' &&
    a.symbol.length <= 12
  );
}

async function fetchSnapshots(symbols, key, secret) {
  const batches = chunks(symbols, SNAPSHOT_BATCH);
  const responses = await mapConcurrent(batches, 3, async batch => {
    const url = new URL('https://data.alpaca.markets/v2/stocks/snapshots');
    url.searchParams.set('symbols', batch.join(','));
    url.searchParams.set('feed', 'iex');
    const r = await dataFetch(url, {
      headers: {
        'APCA-API-KEY-ID': key,
        'APCA-API-SECRET-KEY': secret
      }
    });
    const data = await r.json().catch(()=>({}));
    if (!r.ok) {
      if(r.status===429) throw new Error('Alpaca market-data rate limit persisted after retries');
      return {};
    }
    return data?.snapshots || data || {};
  });
  return Object.assign({}, ...responses);
}

function prefilter(snapshotMap) {
  const rows = Object.entries(snapshotMap).map(([symbol, s]) => {
    const daily = s?.dailyBar || s?.daily_bar;
    const prev = s?.prevDailyBar || s?.prev_daily_bar;
    const quote = s?.latestQuote || s?.latest_quote;
    const trade = s?.latestTrade || s?.latest_trade;
    const minute = s?.minuteBar || s?.minute_bar;

    const price = Number(trade?.p || minute?.c || daily?.c || 0);
    const volume = Number(daily?.v || 0);
    const prevClose = Number(prev?.c || 0);
    const sessionOpen = Number(daily?.o || 0);
    const dollarVolume = price * volume;
    const dayChange = prevClose > 0 ? (price - prevClose) / prevClose : 0;
    const gapPct = prevClose > 0 && sessionOpen > 0 ? (sessionOpen - prevClose) / prevClose : 0;
    const moveFromOpenPct = sessionOpen > 0 && price > 0 ? (price - sessionOpen) / sessionOpen : 0;

    const bid = Number(quote?.bp || 0);
    const ask = Number(quote?.ap || 0);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
    const spreadPct = mid > 0 && ask >= bid ? (ask - bid) / mid : null;

    const timestamp = quote?.t || trade?.t || minute?.t || daily?.t || null;
    const ageSeconds = timestamp
      ? Math.max(0, (Date.now() - new Date(timestamp).getTime()) / 1000)
      : null;

    return {
      symbol, price, volume, dollarVolume, dayChange, gapPct, moveFromOpenPct,
      bid, ask, spreadPct, snapshot_timestamp: timestamp, data_age_seconds: ageSeconds
    };
  }).filter(x =>
    Number.isFinite(x.price) &&
    x.price >= 3 &&
    Number.isFinite(x.dollarVolume) &&
    x.dollarVolume >= 1_000_000
  );

  rows.sort((a,b) => {
    const as = Math.log10(Math.max(1, a.dollarVolume)) + Math.min(0.5, Math.abs(a.dayChange) * 5);
    const bs = Math.log10(Math.max(1, b.dollarVolume)) + Math.min(0.5, Math.abs(b.dayChange) * 5);
    return bs - as;
  });
  return rows.slice(0, DEEP_SCAN_LIMIT);
}

export async function fetchBarsForSymbols(symbols, key, secret, days = 120) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const batches = chunks([...new Set(symbols)], HISTORY_BATCH);

  const pages = await mapConcurrent(batches, 2, async batch => {
    const combined = {};
    let token = null;
    let guard = 0;
    do {
      const url = new URL('https://data.alpaca.markets/v2/stocks/bars');
      url.searchParams.set('symbols', batch.join(','));
      url.searchParams.set('timeframe', '1Day');
      url.searchParams.set('start', start.toISOString());
      url.searchParams.set('end', end.toISOString());
      url.searchParams.set('adjustment', 'all');
      url.searchParams.set('feed', 'iex');
      url.searchParams.set('limit', '10000');
      if (token) url.searchParams.set('page_token', token);

      const r = await dataFetch(url, {
        headers: {
          'APCA-API-KEY-ID': key,
          'APCA-API-SECRET-KEY': secret
        }
      });
      const data = await r.json().catch(()=>({}));
      if (!r.ok) {
        const detail=String(data?.message||data?.error||r.statusText||'Historical market data request failed');
        throw new Error(`Historical market data HTTP ${r.status}: ${detail}`);
      }

      for (const [symbol, bars] of Object.entries(data?.bars || {})) {
        combined[symbol] = (combined[symbol] || []).concat(bars || []);
      }
      token = data?.next_page_token || null;
      guard++;
    } while (token && guard < 12);
    return combined;
  });

  return Object.assign({}, ...pages);
}

export async function fetchMarketScan(key, secret) {
  const cached=globalThis.__aiTraderMarketScanCache;
  if(cached?.value&&cached.expires>Date.now()){
    return {...cached.value, cache_hit:true};
  }

  const assets = await fetchAssets(key, secret);
  const symbols = assets.map(a => a.symbol);
  const snapshots = await fetchSnapshots(symbols, key, secret);
  const liquid = prefilter(snapshots);
  const liquidBySymbol = new Map(liquid.map(x => [x.symbol, x]));
  const deepSymbols = liquid.map(x => x.symbol);
  const contextSymbols = [...new Set([...deepSymbols, 'SPY', ...SECTOR_ETFS])];
  const barsBySymbol = await fetchBarsForSymbols(contextSymbols, key, secret, 120);
  const regime = detectMarketRegime(barsBySymbol.SPY || []);

  const breadthUniverse = Object.entries(snapshots).map(([symbol, s]) => {
    const daily = s?.dailyBar || s?.daily_bar;
    const prev = s?.prevDailyBar || s?.prev_daily_bar;
    const close = Number(daily?.c || s?.latestTrade?.p || 0);
    const prevClose = Number(prev?.c || 0);
    return prevClose > 0 && close > 0 ? (close - prevClose) / prevClose : null;
  }).filter(Number.isFinite);

  const advancers = breadthUniverse.filter(x => x > 0).length;
  const decliners = breadthUniverse.filter(x => x < 0).length;
  const advanceRatio = breadthUniverse.length ? advancers / breadthUniverse.length : 0.5;
  let breadthLabel = 'MIXED';
  let breadthAdjustment = 0;
  if (advanceRatio >= 0.62) { breadthLabel = 'STRONG'; breadthAdjustment = 3; }
  else if (advanceRatio <= 0.38) { breadthLabel = 'WEAK'; breadthAdjustment = -4; }

  regime.breadth = {
    label: breadthLabel,
    advance_ratio: advanceRatio,
    advancers,
    decliners,
    measured: breadthUniverse.length
  };

  const sectorRows = SECTOR_ETFS.map(symbol => {
    const closes = (barsBySymbol[symbol] || []).map(b => Number(b.c)).filter(Number.isFinite);
    const ret20 = closes.length >= 21 ? pctChange(closes.at(-21), closes.at(-1)) : 0;
    return { symbol, return_20d: ret20 };
  }).sort((a,b) => b.return_20d - a.return_20d);

  regime.sector_leaders = sectorRows.slice(0,3);
  regime.sector_laggards = sectorRows.slice(-3).reverse();

  const sectorRank = new Map();
  const sectorDenom = Math.max(1, sectorRows.length - 1);
  sectorRows.forEach((row,index) => {
    sectorRank.set(row.symbol, {
      return_20d: row.return_20d,
      strength_percentile: 1 - index / sectorDenom,
      rank: index + 1
    });
  });

  const benchmark20 = Number(regime.spy_20d || 0);

  let candidates = deepSymbols
    .map(symbol => {
      const result = analyze(symbol, barsBySymbol[symbol] || [], {
        benchmark20,
        regimeAdjustment: regime.score_adjustment + breadthAdjustment
      });
      if (!result) return null;
      const snap = liquidBySymbol.get(symbol) || {};
      const marketRisk = marketRiskMetrics(barsBySymbol[symbol] || [], barsBySymbol);
      return {
        ...result,
        ...marketRisk,
        bid: snap.bid || null,
        ask: snap.ask || null,
        spread_pct: snap.spreadPct,
        snapshot_timestamp: snap.snapshot_timestamp || null,
        data_age_seconds: snap.data_age_seconds,
        day_change: snap.dayChange || 0,
        gap_pct: snap.gapPct || 0,
        move_from_open_pct: snap.moveFromOpenPct || 0
      };
    })
    .filter(Boolean);

  const above20 = candidates.filter(c => Number(c.price) > Number(c.sma20)).length;
  const above50 = candidates.filter(c => Number(c.price) > Number(c.sma50)).length;
  const momentumRows = candidates.map(c => Number(c.momentum_20d)).filter(Number.isFinite).sort((a,b)=>a-b);
  const medianMomentum20 = momentumRows.length
    ? momentumRows.length % 2
      ? momentumRows[Math.floor(momentumRows.length/2)]
      : (momentumRows[momentumRows.length/2-1] + momentumRows[momentumRows.length/2]) / 2
    : 0;

  const pctAbove20 = candidates.length ? above20 / candidates.length : 0.5;
  const pctAbove50 = candidates.length ? above50 / candidates.length : 0.5;

  let participationLabel = 'MIXED';
  let participationAdjustment = 0;
  if (pctAbove20 >= 0.65 && pctAbove50 >= 0.58 && medianMomentum20 > 0) {
    participationLabel = 'BROAD';
    participationAdjustment = 3;
  } else if (pctAbove20 <= 0.35 && pctAbove50 <= 0.35) {
    participationLabel = 'THIN';
    participationAdjustment = -5;
  }

  regime.participation = {
    label: participationLabel,
    pct_above_sma20: pctAbove20,
    pct_above_sma50: pctAbove50,
    median_momentum_20d: medianMomentum20,
    measured: candidates.length
  };

  const rsRanks = percentileRanks(candidates, 'relative_strength_20d');
  const ramRanks = percentileRanks(candidates, 'risk_adjusted_momentum');

  candidates = candidates.map(c => {
    const rsPercentile = rsRanks.get(c.symbol) ?? 0.5;
    const ramPercentile = ramRanks.get(c.symbol) ?? 0.5;
    let score = c.score + participationAdjustment;
    const sectorStrength = c.sector_proxy ? sectorRank.get(c.sector_proxy) : null;

    if (rsPercentile >= 0.90) score += 6;
    else if (rsPercentile >= 0.75) score += 3;
    else if (rsPercentile <= 0.25) score -= 5;

    if (ramPercentile >= 0.85) score += 4;
    else if (ramPercentile <= 0.20) score -= 3;

    if (c.spread_pct != null && c.spread_pct <= 0.0015) score += 2;
    else if (c.spread_pct != null && c.spread_pct > 0.005) score -= 8;

    if (c.beta_60d != null && c.beta_60d > 2.0) score -= 5;
    if (c.sector_correlation != null && c.sector_correlation >= 0.70) score += 2;

    if (sectorStrength && Number(c.sector_correlation || 0) >= 0.55) {
      if (sectorStrength.strength_percentile >= 0.80) score += 4;
      else if (sectorStrength.strength_percentile <= 0.20) score -= 4;
    }
    if (Math.abs(Number(c.gap_pct || 0)) >= 0.07) score -= 6;
    if (Number(c.gap_pct || 0) > 0.04 && Number(c.move_from_open_pct || 0) < -0.02) score -= 8;

    score = Math.max(0, Math.min(100, Math.round(score)));

    return {
      ...c,
      score,
      rs_percentile: rsPercentile,
      risk_adjusted_momentum_percentile: ramPercentile,
      sector_return_20d: sectorStrength?.return_20d ?? null,
      sector_strength_percentile: sectorStrength?.strength_percentile ?? null,
      sector_rank: sectorStrength?.rank ?? null,
      setup: score >= 82 ? 'STRONG' : score >= 68 ? 'GOOD' : score < 45 ? 'WEAK' : 'WATCH'
    };
  }).sort((a,b) => b.score - a.score);

  candidates = candidates.map((c, index) => ({
    ...c,
    historical_edge: index < 20
      ? historicalAnalogEdge(barsBySymbol[c.symbol] || [], c.setup_type)
      : null
  }));

  const result={
    universe_size: symbols.length,
    snapshot_count: Object.keys(snapshots).length,
    deep_scan_size: deepSymbols.length,
    analyzed: candidates.length,
    regime,
    candidates,
    cache_hit:false
  };
  globalThis.__aiTraderMarketScanCache={
    value:result,
    expires:Date.now()+MARKET_SCAN_CACHE_MS
  };
  return result;
}

export async function fetchCandidates(key, secret) {
  const scan = await fetchMarketScan(key, secret);
  return scan.candidates;
}
