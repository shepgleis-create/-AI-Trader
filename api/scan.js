import { UNIVERSE, fetchCandidates } from '../lib/strategy.js';

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
    const results = await fetchCandidates(key, secret);
    return res.status(200).json({
      generated_at: new Date().toISOString(),
      universe_size: UNIVERSE.length,
      analyzed: results.length,
      note: 'Quantitative paper-trading scanner. Scores are signals, not guarantees.',
      candidates: results.slice(0, 10)
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Could not load Alpaca market data' });
  }
}
