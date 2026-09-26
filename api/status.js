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

  // Safety guard: this stage is intentionally paper-only.
  if (!baseUrl.includes('paper-api.alpaca.markets')) {
    return res.status(403).json({
      error: 'Paper-only safety lock is enabled. Live trading endpoint rejected.'
    });
  }

  const headers = {
    'APCA-API-KEY-ID': key,
    'APCA-API-SECRET-KEY': secret
  };

  try {
    const [accountRes, clockRes, positionsRes] = await Promise.all([
      fetch(`${baseUrl}/v2/account`, { headers }),
      fetch(`${baseUrl}/v2/clock`, { headers }),
      fetch(`${baseUrl}/v2/positions`, { headers })
    ]);

    const [account, clock, positions] = await Promise.all([
      accountRes.json(),
      clockRes.json(),
      positionsRes.json()
    ]);

    if (!accountRes.ok || !clockRes.ok || !positionsRes.ok) {
      return res.status(502).json({
        error: 'Alpaca request failed',
        account: accountRes.ok ? undefined : account?.message,
        clock: clockRes.ok ? undefined : clock?.message,
        positions: positionsRes.ok ? undefined : positions?.message
      });
    }

    return res.status(200).json({
      mode: 'PAPER',
      account: {
        status: account.status,
        cash: Number(account.cash || 0),
        portfolio_value: Number(account.portfolio_value || 0),
        buying_power: Number(account.buying_power || 0)
      },
      market: {
        is_open: Boolean(clock.is_open),
        timestamp: clock.timestamp,
        next_open: clock.next_open,
        next_close: clock.next_close
      },
      positions: Array.isArray(positions)
        ? positions.map((p) => ({
            symbol: p.symbol,
            qty: Number(p.qty || 0),
            side: p.side,
            market_value: Number(p.market_value || 0),
            avg_entry_price: Number(p.avg_entry_price || 0),
            current_price: Number(p.current_price || 0),
            unrealized_pl: Number(p.unrealized_pl || 0),
            unrealized_plpc: Number(p.unrealized_plpc || 0)
          }))
        : []
    });
  } catch (error) {
    return res.status(500).json({ error: 'Could not reach Alpaca' });
  }
}
