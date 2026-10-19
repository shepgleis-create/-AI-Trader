# AI Trader V2 — streaming research worker (migration stage 1)

This directory is a **separate long-running research plane inside the EXISTING AI Trader repository**. It does not replace `api/auto-cycle.js`, existing Vercel production, Neon, saved portfolio history or paper Alpaca orders.

The code connects to the **public Coinbase Exchange market-data WebSocket**, dynamically discovers available USD products (including suitable meme-coin products), and raises a machine-readable **WATCH** event for price acceleration. It can restart after exchange connection loss and publishes localhost-only health and recent-alert endpoints.

**This is not LEAN or Freqtrade yet.** Those are upstream open-source engines that must be installed, integrated and independently tested in the next migration phase. Do not mistake this small research service for a completed production-grade multi-asset trading engine.

## Run it

Requires Node.js 22 or later, or an always-on Linux host with Docker.

```bash
cd engine-v2
npm test
npm start
# in a second terminal:
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/signals
```

Or deploy to your own Docker host:

```bash
cd engine-v2
cp .env.example .env
docker compose up --build -d
docker compose logs -f coinbase-research
```

Local environment options: `MAX_PAIRS` (default 150), `WATCH_PAIRS` (comma-separated specific USD products), `MIN_WATCH_MOVE_PCT`, `MIN_OBSERVED_TURNOVER_USD`. When `WATCH_PAIRS` is empty, Coinbase's public product list determines the eligible USD pair universe. Not every Coinbase asset is trading-enabled or has a USD pair. An empty/outdated product list is an ERROR, not an empty market.

The health API is bound to **127.0.0.1 only** by default; Docker forwards host 127.0.0.1:8787. Do not expose this endpoint to the public internet. If you need remote access later, proxy authenticated read-only status into the existing Vercel dashboard.

### Safety guarantees

- No broker API credentials are accepted, stored, read or transmitted.
- No order entry, cancellation, position close or live trading endpoints are present.
- All signals have `mode: RESEARCH_ONLY` and `execution_allowed: false`.
- Output is exchange-only market data, **not consolidated across crypto exchanges**.
- The ticker-batch feed may be sampled and is not an exact full-tick trade ledger.
- The observed turnover estimate uses received tick sizes, **not verified venue-wide volume**.
- Alerts indicate price acceleration after a detected move; they are **not guaranteed leading signals**, low price entry opportunities, predictions, or recommendations.
- A 24/7 host is required. Vercel serverless Functions cannot retain a permanent WebSocket connection.
- No live result is claimed until a real worker host connects and its logs, reconnect behavior and source coverage are verified.

## Machine-readable market event

```json
{
  "schema": "ai_trader_market_event_v2",
  "kind": "TRADE_TICK",
  "source": "COINBASE_EXCHANGE_PUBLIC",
  "asset_class": "CRYPTO",
  "symbol": "BTC-USD",
  "venue": "COINBASE_EXCHANGE",
  "price": 60000,
  "event_at": "2026-10-19T12:00:00.000Z",
  "received_at": "2026-10-19T12:00:00.050Z",
  "provider_coverage": "COINBASE_EXCHANGE_PAIRS_ONLY",
  "research_only": true
}
```

`stream-core.mjs` validates events and emits bounded `PRICE_ACCELERATION_WATCH` messages with observed return, quote spread, limited venue turnover and uncertainty labels. New adapters (Tradier stock/options, other crypto exchanges, and LEAN/Freqtrade execution) must normalize into their own explicit provider/venue schema and cannot silently relabel one venue as the whole market.

## Next migration milestone

1. Connect this research service to Neon using a separately permissioned write key and durable replay/idempotency; use a controlled authenticated ingestion API, **not** unauthenticated public POST.
2. Choose an always-on host (an inexpensive VPS/container service) and verify stable Coinbase WebSocket coverage for 24–72 hours.
3. Integrate LEAN backtesting and **paper** execution for US stocks/options, choosing an actually entitled feed: Tradier-linked brokerage versus Alpaca Plus versus Massive. There is no free public nationwide consolidated real-time tape.
4. Add Freqtrade/FreqAI dry-run as a second engine only if its exchange support, user jurisdiction and central account-risk adapter are fully validated.
5. Implement central broker position reconciler, protective exit handling, fees/slippage modeling, strategy promotion gate, kill switch and failure alerts before expanding the automated trading rate.
6. Preserve everything in the existing Vercel dashboard; do not switch execution until paper broker fills and stop-loss operation are confirmed on the replacement.

Details and vendor cost comparisons: [../AI_TRADER_V2_ARCHITECTURE.md](../AI_TRADER_V2_ARCHITECTURE.md).
