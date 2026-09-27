import { requireDashboardAuth } from '../lib/auth.js';
import { getPortfolioRisk } from '../lib/risk.js';

async function getAsset(symbol, baseUrl, headers) {
  const r = await fetch(`${baseUrl}/v2/assets/${encodeURIComponent(symbol)}`, { headers });
  const data = await r.json();
  return r.ok ? data : null;
}

async function getLatestPrice(symbol, key, secret) {
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
  return Number(s?.latestTrade?.p || s?.minuteBar?.c || s?.dailyBar?.c || 0) || null;
}

export default async function handler(req, res) {
  if (!requireDashboardAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  const baseUrl = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';

  if (!key || !secret) return res.status(500).json({ error: 'Missing Alpaca environment variables' });
  if (!baseUrl.includes('paper-api.alpaca.markets')) {
    return res.status(403).json({ error: 'Live trading endpoint rejected by safety lock.' });
  }

  const symbol = String(req.body?.symbol || '').toUpperCase().trim();
  const scannerScore = Number(req.body?.score);
  if (!symbol || !Number.isFinite(scannerScore) || scannerScore < 82) {
    return res.status(400).json({ error: 'A valid symbol with scanner score 82+ is required.' });
  }

  const headers = {
    'APCA-API-KEY-ID': key,
    'APCA-API-SECRET-KEY': secret,
    'Content-Type': 'application/json'
  };

  try {
    const [accountRes, clockRes, positionsRes, ordersRes, asset] = await Promise.all([
      fetch(`${baseUrl}/v2/account`, { headers }),
      fetch(`${baseUrl}/v2/clock`, { headers }),
      fetch(`${baseUrl}/v2/positions`, { headers }),
      fetch(`${baseUrl}/v2/orders?status=open&limit=100&nested=true`, { headers }),
      getAsset(symbol, baseUrl, headers)
    ]);

    const [account, clock, positionsRaw, ordersRaw] = await Promise.all([
      accountRes.json(), clockRes.json(), positionsRes.json(), ordersRes.json()
    ]);

    if (!accountRes.ok || !clockRes.ok || !positionsRes.ok || !ordersRes.ok) {
      return res.status(502).json({ error: 'Could not complete pre-trade safety checks.' });
    }

    if (!asset || asset.status !== 'active' || !asset.tradable) {
      return res.status(400).json({ error: 'This symbol is not currently an active tradable Alpaca U.S. equity.' });
    }

    if (!clock.is_open) {
      return res.status(409).json({
        error: 'Market is closed. This execution test only submits during regular market hours.',
        next_open: clock.next_open
      });
    }

    if (account.trading_blocked || account.account_blocked) {
      return res.status(403).json({ error: 'Alpaca account is currently blocked from trading.' });
    }

    const positions = Array.isArray(positionsRaw) ? positionsRaw : [];
    const orders = Array.isArray(ordersRaw) ? ordersRaw : [];
    const portfolioRisk = getPortfolioRisk(account, positions);

    if (portfolioRisk.daily_loss_lock || portfolioRisk.exposure_lock || portfolioRisk.position_lock) {
      return res.status(409).json({
        error: 'Risk lock blocked this test order.',
        risk: portfolioRisk
      });
    }

    if (positions.some(p => p.symbol === symbol)) {
      return res.status(409).json({ error: `Already holding ${symbol}; duplicate entry blocked.` });
    }
    if (orders.some(o => o.symbol === symbol)) {
      return res.status(409).json({ error: `An open order already exists for ${symbol}.` });
    }

    const price = await getLatestPrice(symbol, key, secret);
    if (!(price > 0)) return res.status(502).json({ error: 'Could not get a current reference price.' });

    const notional = Math.max(1, Math.min(25, Number(account.portfolio_value || 0) * 0.02, Number(account.cash || 0)));
    let qty;

    if (asset.fractionable) {
      qty = Number((notional / price).toFixed(8));
    } else {
      qty = Math.floor(notional / price);
      if (qty < 1) {
        return res.status(409).json({ error: 'This asset is not fractionable and exceeds the $25 calibration order cap.' });
      }
    }

    const stopPrice = (price * 0.97).toFixed(2);
    const takeProfitPrice = (price * 1.06).toFixed(2);

    const orderRes = await fetch(`${baseUrl}/v2/orders`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        symbol,
        qty: qty.toString(),
        side: 'buy',
        type: 'market',
        time_in_force: 'day',
        order_class: 'bracket',
        take_profit: { limit_price: takeProfitPrice },
        stop_loss: { stop_price: stopPrice },
        client_order_id: `aitest-${symbol.toLowerCase()}-${String(Date.now()).slice(-10)}`
      })
    });

    const order = await orderRes.json();
    if (!orderRes.ok) {
      return res.status(orderRes.status).json({
        error: order?.message || 'Alpaca rejected the bracket paper order.'
      });
    }

    return res.status(200).json({
      success: true,
      mode: 'PAPER',
      symbol,
      qty,
      approximate_notional: qty * price,
      reference_price: price,
      stop_price: Number(stopPrice),
      take_profit_price: Number(takeProfitPrice),
      order_id: order.id,
      status: order.status,
      message: `Bracket paper order submitted for ${symbol} with broker-side stop and target.`
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Paper order request failed.' });
  }
}
