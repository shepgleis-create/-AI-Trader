const UNIVERSE = [
  'SPY','QQQ','IWM','DIA',
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA',
  'AVGO','AMD','NFLX','JPM','BAC','XOM','CVX',
  'LLY','UNH','COST','WMT','HD','CRM','ORCL'
];

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

function analyze(symbol, bars) {
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

  if (price > sma20) { score += 10; reasons.push('Price above 20-day trend'); }
  else score -= 10;

  if (sma20 > sma50) { score += 14; reasons.push('20-day trend above 50-day trend'); }
  else score -= 12;

  if (mom20 > 0.08) { score += 12; reasons.push('Strong 20-day momentum'); }
  else if (mom20 > 0.02) { score += 6; reasons.push('Positive 20-day momentum'); }
  else if (mom20 < -0.08) score -= 12;
  else if (mom20 < 0) score -= 5;

  if (mom5 > 0) { score += 4; reasons.push('Positive 5-day momentum'); }
  else score -= 3;

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
    symbol,
    score,
    setup,
    price,
    sma20,
    sma50,
    rsi14,
    momentum_5d: mom5,
    momentum_20d: mom20,
    volume_ratio: volumeRatio,
    reasons: reasons.slice(0, 4)
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  const baseUrl = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';

  if (!key || !secret) {
    return res.status(500).json({ error: 'Missing Alpaca environment variables' });
  }

  // Keep this stage tied to the paper account configuration.
  if (!baseUrl.includes('paper-api.alpaca.markets')) {
    return res.status(403).json({ error: 'Paper-only safety lock is enabled.' });
  }

  const end = new Date();
  const start = new Date(end.getTime() - 150 * 24 * 60 * 60 * 1000);
  const url = new URL('https://data.alpaca.markets/v2/stocks/bars');
  url.searchParams.set('symbols', UNIVERSE.join(','));
  url.searchParams.set('timeframe', '1Day');
  url.searchParams.set('start', start.toISOString());
  url.searchParams.set('end', end.toISOString());
  url.searchParams.set('adjustment', 'raw');
  url.searchParams.set('feed', 'iex');
  url.searchParams.set('limit', '10000');

  try {
    const response = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID': key,
        'APCA-API-SECRET-KEY': secret
      }
    });
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.message || 'Market data request failed'
      });
    }

    const barsBySymbol = data.bars || {};
    const results = UNIVERSE
      .map(symbol => analyze(symbol, barsBySymbol[symbol] || []))
      .filter(Boolean)
      .sort((a,b) => b.score - a.score);

    return res.status(200).json({
      generated_at: new Date().toISOString(),
      universe_size: UNIVERSE.length,
      analyzed: results.length,
      note: 'Quantitative paper-trading scanner. Scores are signals, not guarantees.',
      candidates: results.slice(0, 10)
    });
  } catch (error) {
    return res.status(500).json({ error: 'Could not load Alpaca market data' });
  }
}
