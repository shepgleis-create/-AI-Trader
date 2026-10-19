# AI Trader V2 — Open-source engine migration (2026-10-19)

## Decision

**Preserve the existing** GitHub repository, authenticated Vercel dashboard, Neon records, paper Alpaca account and closed-trade history. The current Vercel cron traders stay isolated while V2 is proven. Build an **always-on, event-driven execution plane** outside Vercel's serverless cron runtime, with replaceable market data and brokerage adapters.

**No automatic live-money orders or elevated trade limits are authorized by this migration.** Research signals are not executable orders. This specification deliberately has no live broker secrets or order-placement endpoints.

## Verified open-source shortlist

| Role | Candidate | Why / constraints |
| --- | --- | --- |
| Primary multi-asset engine | [QuantConnect LEAN](https://github.com/QuantConnect/Lean) | Apache-2.0 event-driven open-source research/backtest/live engine; adapters for equities, options, futures and crypto. Its commercial **LEAN CLI local live** commands currently require a paid QuantConnect organization; self-hosting the engine from source/image is an alternative and is *not* yet integrated here. |
| Crypto-specific execution/research | [Freqtrade + FreqAI](https://github.com/freqtrade/freqtrade) | Open source 24/7 spot crypto bot with backtests and model retraining. Broker/exchange availability, geography and API permission must be checked before connection. FreqAI is not guaranteed to outperform a simple strategy. |
| Rust-oriented alternative | [NautilusTrader](https://github.com/nautechsystems/nautilus_trader) | High-throughput Python/Rust event-driven engine with strong broker-adapter architecture; adopting it would require qualifying venue adapters for *each* asset class. |

Using two engines has orchestration/operational costs. Initially use one unified risk and event contract; do not duplicate independent account risk limits across engines.

## Data and brokerage options (verify subscription terms before purchasing)

- **Alpaca Basic:** free, broad US symbol catalog but equity real-time IEX-only; OPRA consolidated options feed is not included. **Algo Trader Plus:** $99/month individual for consolidated US equity feeds + OPRA options (approx. $1,188 / 12 months). https://docs.alpaca.markets/us/docs/about-market-data-api
- **Tradier Brokerage:** its *funded brokerage API* offers consolidated real-time stocks and options market data to account holders, but sandbox data is delayed; entitlement, usage rules, account eligibility and real-time feed permissions must be checked. https://docs.tradier.com/docs/market-data — separate broker connection needed, not an automatic Alpaca upgrade.
- **Massive (formerly Polygon):** around $199/month each for full real-time US stocks Advanced or options Advanced individual plans; delayed plans cost less. Not a free consolidated live feed. https://massive.com/stocks and https://massive.com/pricing?product=options
- **Coinbase Exchange public WebSocket:** stream USD cryptocurrency pairs without private broker credentials for research; exchange inventory is **not all coins** and venue data is not universal consolidated crypto. https://help.coinbase.com/en/developer-platform/websocket-feeds/exchange
- **LEAN engine and Coinbase public feeds do not eliminate exchange licensing, broker qualifications, spread, slippage, or day-trading rules.** FINRA margin rule changes effective 2026-06-04 allow a transition until 2027-10-20; broker adoption and account status must be checked rather than assuming unlimited permitted intraday trades. https://www.investor.gov/introduction-investing/investing-basics/glossary/pattern-day-trader

## V2 architecture

```text
US equity SIP or entitled broker streaming data   Crypto exchange public WS feeds
                     |                                 |
              Data-provider adapters  (timestamp, venue, bid, ask, spread, sequence)
                                   |
             24/7 event bus / watchlists / volume acceleration detectors
                                   |
          Strategies (momentum, breakout, mean reversion, volatility, options)
                                   |
                Research + forward-grade + shadow evaluation
                                   |
             Independent account-level execution and risk gate
                                   |
             Broker adapter (paper first; live disabled)
                                   |
                Fill reconciliation, audit ledger, P/L
                                   |
                     Existing Neon + Vercel UI
```

Always-on service: Docker on a VM/VPS or other long-running worker host. Vercel stays UI/API/control plane. A 15-minute cron is not a low-latency market-data stream.

## Anti-misleading design

- Discover **all symbols licensed by the provider**; separately report exact exchange coverage and latency. Never describe a single-venue feed as consolidated.
- Distinguish WATCH, PAPER_SIGNAL, ORDER_ACCEPTED, PARTIAL_FILL, FILL, CANCELED and REJECTED.
- Do not equate trade count with profit; benchmark net P/L after bid/ask spread, fees and slippage.
- Limit position size, loss/day, account exposure, order rate, max concurrent orders; maintain an emergency kill switch.
- No on-demand LLM call in the critical stop-loss or order fill path; LLM can review research asynchronously.
- Simulate latency and missed fills before trusting a high-frequency strategy. Do not claim the best entry/exit price is knowable in advance.
- Providers and engines are independently versioned: missing feed permissions must produce a visible error, not a false no-opportunity result.

## Implementation status

- [x] Existing app and paper orders preserved; migration work in `engine-v2/` only.
- [x] Independent no-credentials Coinbase public market stream prototype and signal normalization (RESEARCH_ONLY, no trading).
- [x] Provider-agnostic engine message contract and replayable unit tests.
- [ ] Deploy an **always-on worker host** (requires hosting connection/choice).
- [ ] Install, license-check and validate upstream LEAN or Nautilus live instance; not already installed by scaffold.
- [ ] Evaluate Tradier brokerage entitlement vs Alpaca Plus / Massive; connect only with user authorization.
- [ ] Evaluate Freqtrade/FreqAI with exchange-specific eligibility and dry-run.
- [ ] Build robust account-wide broker adapter, idempotent order journal, fill reconciliation and kill switch.
- [ ] Measure streaming coverage, outages, costs, latency, fill rate, net realized P/L and backtest-vs-forward divergence over meaningful paper sample.
- [ ] Obtain explicit authorization and independent safeguards before any live-money operation.

## Migration cutover rules

1. No replacement of the current Vercel bot until V2 demonstrates stable feeds, protective exits, and order-state reconciliation in dry-run/paper.
2. Never run two engines with the ability to submit orders to the same brokerage account without a shared order/risk lock.
3. All newly proposed broker integrations and data purchases require user action; no implicit subscription or live-order promotion.
