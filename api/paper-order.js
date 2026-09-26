const ALLOWED = new Set([
  'SPY','QQQ','IWM','DIA',
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','TSLA',
  'AVGO','AMD','NFLX','JPM','BAC','XOM','CVX',
  'LLY','UNH','COST','WMT','HD','CRM','ORCL'
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  const baseUrl = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';

  if (!key || !secret) {
    return res.status(500).json({ error: 'Missing Alpaca environment variables' });
  }

  // Hard safety lock: this endpoint is paper-only.
  if (!baseUrl.includes('paper-api.alpaca.markets')) {
    return res.status(403).json({ error: 'Live trading endpoint rejected by safety lock.' });
  }

  const symbol = String(req.body?.symbol || '').toUpperCase().trim();
  const scannerScore = Number(req.body?.score);

  if (!ALLOWED.has(symbol)) {
    return res.status(400).json({ error: 'Symbol is not in the approved starter universe.' });
  }

  // The UI only enables this for strong scanner setups, but the server checks too.
  if (!Number.isFinite(scannerScore) || scannerScore < 78) {
    return res.status(400).json({ error: 'Scanner score must be at least 78 for this test order.' });
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
      fetch(`${baseUrl}/v2/orders?status=open&limit=100`, { headers })
    ]);

    const [account, clock, positions, orders] = await Promise.all([
      accountRes.json(),
      clockRes.json(),
      positionsRes.json(),
      ordersRes.json()
    ]);

    if (!accountRes.ok || !clockRes.ok || !positionsRes.ok || !ordersRes.ok) {
      return res.status(502).json({ error: 'Could not complete pre-trade safety checks.' });
    }

    if (!clock.is_open) {
      return res.status(409).json({
        error: 'Market is closed. This test only submits during regular market hours.',
        next_open: clock.next_open
      });
    }

    if (account.trading_blocked || account.account_blocked) {
      return res.status(403).json({ error: 'Alpaca account is currently blocked from trading.' });
    }

    const openPositions = Array.isArray(positions) ? positions : [];
    if (openPositions.length >= 3) {
      return res.status(409).json({ error: 'Safety limit reached: maximum 3 open positions.' });
    }

    if (openPositions.some(p => p.symbol === symbol)) {
      return res.status(409).json({ error: `Already holding ${symbol}; duplicate entry blocked.` });
    }

    const openOrders = Array.isArray(orders) ? orders : [];
    if (openOrders.some(o => o.symbol === symbol)) {
      return res.status(409).json({ error: `An open order already exists for ${symbol}.` });
    }

    const portfolioValue = Number(account.portfolio_value || 0);
    const cash = Number(account.cash || 0);

    // First execution-test sizing: max $25, or 2% of portfolio if smaller.
    const notional = Math.max(1, Math.min(25, portfolioValue * 0.02));

    if (cash < notional) {
      return res.status(409).json({ error: 'Not enough paper cash for the test order.' });
    }

    const orderRes = await fetch(`${baseUrl}/v2/orders`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        symbol,
        notional: notional.toFixed(2),
        side: 'buy',
        type: 'market',
        time_in_force: 'day',
        client_order_id: `aitest-${symbol.toLowerCase()}-${Date.now()}`
      })
    });

    const order = await orderRes.json();

    if (!orderRes.ok) {
      return res.status(orderRes.status).json({
        error: order?.message || 'Alpaca rejected the paper order.'
      });
    }

    return res.status(200).json({
      success: true,
      mode: 'PAPER',
      symbol,
      notional,
      order_id: order.id,
      status: order.status,
      submitted_at: order.submitted_at,
      message: `Paper order submitted for approximately $${notional.toFixed(2)} of ${symbol}.`
    });
  } catch (error) {
    return res.status(500).json({ error: 'Paper order request failed.' });
  }
}
