export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  const baseUrl = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';

  if (!key || !secret) {
    return res.status(500).json({
      connected: false,
      error: 'Missing Alpaca environment variables'
    });
  }

  try {
    const response = await fetch(`${baseUrl}/v2/account`, {
      headers: {
        'APCA-API-KEY-ID': key,
        'APCA-API-SECRET-KEY': secret
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        connected: false,
        error: data?.message || 'Alpaca rejected the request'
      });
    }

    return res.status(200).json({
      connected: true,
      status: data.status,
      currency: data.currency,
      cash: data.cash,
      portfolio_value: data.portfolio_value,
      buying_power: data.buying_power,
      trading_blocked: data.trading_blocked,
      account_blocked: data.account_blocked,
      pattern_day_trader: data.pattern_day_trader
    });
  } catch (error) {
    return res.status(500).json({
      connected: false,
      error: 'Could not reach Alpaca'
    });
  }
}
