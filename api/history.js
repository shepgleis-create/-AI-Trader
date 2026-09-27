function parseClientId(id) {
  const s = String(id || '');
  const m = s.match(/^aitr-(g|q)-(.+)-s(\d+)-c(\d+)-/);
  if (!m) {
    return {
      source: s.startsWith('aitest-') ? 'MANUAL_TEST' : null,
      scanner_score: null,
      model_conviction: null
    };
  }
  return {
    source: m[1] === 'g' ? 'GEMINI' : 'QUANT_FALLBACK',
    scanner_score: Number(m[3]),
    model_conviction: Number(m[4])
  };
}

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
    const r = await fetch(`${baseUrl}/v2/orders?status=all&limit=100&direction=desc&nested=true`, {
      headers: {
        'APCA-API-KEY-ID': key,
        'APCA-API-SECRET-KEY': secret
      }
    });
    const orders = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: orders?.message || 'Could not load orders' });

    const rows = (Array.isArray(orders) ? orders : []).map(o => {
      const meta = parseClientId(o.client_order_id);
      return {
        id: o.id,
        symbol: o.symbol,
        side: o.side,
        type: o.type,
        order_class: o.order_class,
        status: o.status,
        notional: o.notional ? Number(o.notional) : null,
        qty: o.qty ? Number(o.qty) : null,
        filled_qty: o.filled_qty ? Number(o.filled_qty) : null,
        filled_avg_price: o.filled_avg_price ? Number(o.filled_avg_price) : null,
        submitted_at: o.submitted_at,
        filled_at: o.filled_at,
        client_order_id: o.client_order_id,
        source: meta.source,
        scanner_score: meta.scanner_score,
        model_conviction: meta.model_conviction,
        protection_legs: Array.isArray(o.legs)
          ? o.legs.map(l => ({
              side: l.side,
              type: l.type,
              status: l.status,
              stop_price: l.stop_price ? Number(l.stop_price) : null,
              limit_price: l.limit_price ? Number(l.limit_price) : null
            }))
          : []
      };
    });

    const botOrders = rows.filter(o => o.source === 'GEMINI' || o.source === 'QUANT_FALLBACK');
    const filled = rows.filter(o => o.status === 'filled');

    return res.status(200).json({
      summary: {
        total_orders: rows.length,
        filled_orders: filled.length,
        autonomous_orders: botOrders.length,
        gemini_orders: botOrders.filter(o => o.source === 'GEMINI').length,
        quant_fallback_orders: botOrders.filter(o => o.source === 'QUANT_FALLBACK').length
      },
      orders: rows
    });
  } catch (error) {
    return res.status(500).json({ error: 'Could not load order history' });
  }
}
