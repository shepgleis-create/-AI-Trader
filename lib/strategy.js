const EXCHANGES = new Set(['NASDAQ','NYSE','ARCA','BATS','AMEX','NYSEARCA']);
const SNAPSHOT_BATCH = 300;
const HISTORY_BATCH = 75;
const DEEP_SCAN_LIMIT = 300;

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a,b) => a + b, 0) / period;
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
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function pctChange(a, b) {
  if (!a || !b) return 0;
  return (b - a) / a;
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

export function analyze(symbol, bars) {
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

  let score = 50;
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
  if (distanceFromHigh <= 0.02) { score += 6; reasons.push('Near 20-day high'); }
  if (volumeRatio >= 1.25) { score += 6; reasons.push('Volume expansion'); }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let setup = 'WATCH';
  if (score >= 78) setup = 'STRONG';
  else if (score >= 66) setup = 'GOOD';
  else if (score < 45) setup = 'WEAK';

  return {
    symbol, score, setup, price, sma20, sma50, rsi14,
    momentum_5d: mom5,
    momentum_20d: mom20,
    volume_ratio: volumeRatio,
    reasons: reasons.slice(0, 4)
  };
}

async function fetchAssets(key, secret) {
  const url = 'https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity';
  const r = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID': key,
      'APCA-API-SECRET-KEY': secret
    }
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.message || 'Could not load U.S. asset universe');

  return (Array.isArray(data) ? data : [])
    .filter(a =>
      a?.status === 'active' &&
      a?.tradable === true &&
      EXCHANGES.has(String(a?.exchange || '').toUpperCase()) &&
      typeof a?.symbol === 'string' &&
      a.symbol.length <= 12
    );
}

async function fetchSnapshots(symbols, key, secret) {
  const batches = chunks(symbols, SNAPSHOT_BATCH);
  const responses = await mapConcurrent(batches, 6, async batch => {
    const url = new URL('https://data.alpaca.markets/v2/stocks/snapshots');
    url.searchParams.set('symbols', batch.join(','));
    url.searchParams.set('feed', 'iex');

    const r = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID': key,
        'APCA-API-SECRET-KEY': secret
      }
    });

    if (!r.ok) return {};
    const data = await r.json();
    return data?.snapshots || data || {};
  });

  return Object.assign({}, ...responses);
}

function prefilter(snapshotMap) {
  const rows = Object.entries(snapshotMap).map(([symbol, s]) => {
    const daily = s?.dailyBar || s?.daily_bar;
    const prev = s?.prevDailyBar || s?.prev_daily_bar;
    const price = Number(daily?.c || s?.latestTrade?.p || 0);
    const volume = Number(daily?.v || 0);
    const prevClose = Number(prev?.c || 0);
    const dollarVolume = price * volume;
    const dayChange = prevClose > 0 ? (price - prevClose) / prevClose : 0;
    return { symbol, price, volume, dollarVolume, dayChange };
  }).filter(x =>
    Number.isFinite(x.price) &&
    x.price >= 3 &&
    Number.isFinite(x.dollarVolume) &&
    x.dollarVolume >= 1_000_000
  );

  // Rank by liquidity first, with extra weight for meaningful movement.
  rows.sort((a,b) => {
    const as = Math.log10(Math.max(1, a.dollarVolume)) + Math.min(0.5, Math.abs(a.dayChange) * 5);
    const bs = Math.log10(Math.max(1, b.dollarVolume)) + Math.min(0.5, Math.abs(b.dayChange) * 5);
    return bs - as;
  });

  return rows.slice(0, DEEP_SCAN_LIMIT);
}

async function fetchHistoricalBars(symbols, key, secret) {
  const end = new Date();
  const start = new Date(end.getTime() - 120 * 24 * 60 * 60 * 1000);
  const batches = chunks(symbols, HISTORY_BATCH);

  const pages = await mapConcurrent(batches, 4, async batch => {
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

      const r = await fetch(url, {
        headers: {
          'APCA-API-KEY-ID': key,
          'APCA-API-SECRET-KEY': secret
        }
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.message || 'Historical market data request failed');

      for (const [symbol, bars] of Object.entries(data?.bars || {})) {
        combined[symbol] = (combined[symbol] || []).concat(bars || []);
      }

      token = data?.next_page_token || null;
      guard++;
    } while (token && guard < 10);

    return combined;
  });

  return Object.assign({}, ...pages);
}

export async function fetchMarketScan(key, secret) {
  const assets = await fetchAssets(key, secret);
  const symbols = assets.map(a => a.symbol);
  const snapshots = await fetchSnapshots(symbols, key, secret);
  const liquid = prefilter(snapshots);
  const deepSymbols = liquid.map(x => x.symbol);
  const barsBySymbol = await fetchHistoricalBars(deepSymbols, key, secret);

  const candidates = deepSymbols
    .map(symbol => analyze(symbol, barsBySymbol[symbol] || []))
    .filter(Boolean)
    .sort((a,b) => b.score - a.score);

  return {
    universe_size: symbols.length,
    snapshot_count: Object.keys(snapshots).length,
    deep_scan_size: deepSymbols.length,
    analyzed: candidates.length,
    candidates
  };
}

export async function fetchCandidates(key, secret) {
  const scan = await fetchMarketScan(key, secret);
  return scan.candidates;
}
