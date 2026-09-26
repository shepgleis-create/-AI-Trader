export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  const baseUrl = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';

  if (!key || !secret) return res.status(500).json({ error: 'Missing Alpaca environment variables' });
  if (!baseUrl.includes('paper-api.alpaca.markets')) {
    return res.status(403).json({ error: 'Paper-only safety lock is enabled.' });
  }

  try {
    const r = await fetch(`${baseUrl}/v2/orders?status=all&limit=50&direction=desc&nested=true`, {
      headers: {
        'APCA-API-KEY-ID': key,
        'APCA-API-SECRET-KEY': secret
      }
    });
    const orders = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: orders?.message || 'Could not load orders' });

    return res.status(200).json({
      orders: (Array.isArray(orders) ? orders : []).map(o => ({
        id: o.id,
        symbol: o.symbol,
        side: o.side,
        type: o.type,
        status: o.status,
        notional: o.notional ? Number(o.notional) : null,
        qty: o.qty ? Number(o.qty) : null,
        filled_qty: o.filled_qty ? Number(o.filled_qty) : null,
        filled_avg_price: o.filled_avg_price ? Number(o.filled_avg_price) : null,
        submitted_at: o.submitted_at,
        filled_at: o.filled_at,
        client_order_id: o.client_order_id
      }))
    });
  } catch (error) {
    return res.status(500).json({ error: 'Could not load order history' });
  }
}
