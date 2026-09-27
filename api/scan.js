import { fetchMarketScan } from '../lib/strategy.js';

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
    const scan = await fetchMarketScan(key, secret);
    return res.status(200).json({
      generated_at: new Date().toISOString(),
      universe_size: scan.universe_size,
      snapshot_count: scan.snapshot_count,
      deep_scan_size: scan.deep_scan_size,
      analyzed: scan.analyzed,
      regime: scan.regime,
      note: 'Market-wide U.S. equity scanner. Every active tradable major-exchange equity is eligible; liquidity/activity filters select the deep-analysis set.',
      candidates: scan.candidates.slice(0, 20)
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not load Alpaca market data' });
  }
}
