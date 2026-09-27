import { requireDashboardAuth } from '../lib/auth.js';
import { getPortfolioRisk } from '../lib/risk.js';
import { fetchMarketClock } from '../lib/alpaca-clock.js';

export default async function handler(req, res) {
  if (!requireDashboardAuth(req, res)) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;
  const baseUrl = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';

  if (!key || !secret) {
    return res.status(500).json({ error: 'Missing Alpaca environment variables' });
  }

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
    const [accountRes, clockPack, positionsRes, ordersRes] = await Promise.all([
      fetch(`${baseUrl}/v2/account`, { headers }),
      fetchMarketClock(baseUrl, headers),
      fetch(`${baseUrl}/v2/positions`, { headers }),
      fetch(`${baseUrl}/v2/orders?status=open&limit=100&nested=true`, { headers })
    ]);

    const [account, positions, orders] = await Promise.all([
      accountRes.json().catch(()=>({})),
      positionsRes.json().catch(()=>([])),
      ordersRes.json().catch(()=>([]))
    ]);
    const clock=clockPack.data||{};

    const failures=[];
    if(!accountRes.ok)failures.push(`account HTTP ${accountRes.status}`);
    if(!clockPack.ok)failures.push(`clock ${clockPack.error||'failed'}`);
    if(!positionsRes.ok)failures.push(`positions HTTP ${positionsRes.status}`);
    if(!ordersRes.ok)failures.push(`open orders HTTP ${ordersRes.status}`);
    if(failures.length){
      return res.status(502).json({ error:`Alpaca status dependency failed — ${failures.join(' · ')}` });
    }

    const positionRows = Array.isArray(positions) ? positions : [];
    const risk = getPortfolioRisk(account, positionRows);
    const protectedSymbols = new Set();
    for (const o of (Array.isArray(orders) ? orders : [])) {
      if (o?.side === 'sell' && o?.symbol) protectedSymbols.add(o.symbol);
      for (const leg of (Array.isArray(o?.legs) ? o.legs : [])) {
        if (leg?.side === 'sell') protectedSymbols.add(leg.symbol || o.symbol);
      }
    }

    return res.status(200).json({
      mode: 'PAPER',
      automation_enabled: String(process.env.AUTO_TRADING_ENABLED || '').toLowerCase() === 'true',
      gemini_configured: Boolean(process.env.GEMINI_API_KEY),
      account: {
        status: account.status,
        cash: Number(account.cash || 0),
        portfolio_value: Number(account.portfolio_value || 0),
        equity: Number(account.equity || 0),
        last_equity: Number(account.last_equity || 0),
        buying_power: Number(account.buying_power || 0)
      },
      risk,
      market: {
        is_open: Boolean(clock.is_open),
        timestamp: clock.timestamp,
        next_open: clock.next_open,
        next_close: clock.next_close,
        clock_source: clockPack.source||null
      },
      positions: positionRows.map((p) => ({
        symbol: p.symbol,
        qty: Number(p.qty || 0),
        side: p.side,
        market_value: Number(p.market_value || 0),
        avg_entry_price: Number(p.avg_entry_price || 0),
        current_price: Number(p.current_price || 0),
        unrealized_pl: Number(p.unrealized_pl || 0),
        unrealized_plpc: Number(p.unrealized_plpc || 0),
        broker_protected: protectedSymbols.has(p.symbol)
      }))
    });
  } catch (error) {
    return res.status(500).json({ error: 'Could not reach Alpaca' });
  }
}
