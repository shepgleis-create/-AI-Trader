# AI Trader — Development checklist
Updated: 2026-10-19
Target: existing `shepgleis-create/-AI-Trader` repository and `ai-trader` Vercel project.

Status language:
- **Implemented** means committed to source, not necessarily observed in production.
- **Deployment READY** means Vercel built and accepted the release, not a verified broker fill.
- **Integration unverified** explicitly identifies work requiring a market session or authenticated broker response.

## Core project preserved
- [x] Paper-only Alpaca routing and autonomous-cycle authorization
- [x] Signed dashboard session; CRON_SECRET authorization for schedules
- [x] Market-wide equity, crypto, options, news, and challenger research
- [x] Gemini/quantitative decisions behind deterministic risk rules
- [x] Neon Decision Memory, scheduled outcome grading, research statistics
- [x] Existing responsive dark dashboard and multi-page navigation
- [x] Existing stock/options/crypto entry routes and operational journal

## October 19 — open-source architecture migration started
- [x] Confirmed Alpaca Basic has IEX-only stock real-time and indicative options data; Algo Trader Plus 99 USD per month for individual full US stock + OPRA data.
- [x] Evaluated upstream QuantConnect LEAN (multi-asset), Freqtrade/FreqAI (crypto), NautilusTrader (Rust/Python) and tradeoffs.
- [x] Identified QuantConnect Cloud licensed consolidated equity/option live algorithm feed as a possible lower-cost alternative to standalone Alpaca SIP; paid cloud tier/node and usage/license restrictions remain.
- [x] Identified Tradier brokerage-entitled real-time US equity/option feed; paper sandbox delayed; streaming explicitly limits whole-exchange bulk requests.
- [x] Wrote AI_TRADER_V2_ARCHITECTURE.md and linked migration entry points in README.
- [x] Created independent Node 22 Coinbase public USD crypto WebSocket watcher with reconnection, stale-socket watchdog and local health/signals API.
- [x] Changed low-volume crypto acceleration to a labeled WATCH instead of suppressing discovery; still never an executable trade.
- [x] Created Dockerfile, Compose deployment and RESEARCH_ONLY environment example; no broker keys, no order placement endpoints.
- [x] Added Tradier read-only quote adapter with conditional live broker entitlement, delayed sandbox metadata and 40-symbol REST watchlist cap.
- [x] Added strict cross-provider market-data provenance contract so delayed sandbox quotes cannot masquerade as real-time data.
- [x] Created GitHub Actions V2 workflow for Node syntax, regression suite and execution-API reference guard.
- [x] Ran 18 isolated deterministic JavaScript unit checks (all passed) covering crypto venue data, Tradier quotes, watch limits, thin-liquidity acceleration and provider identity.
- [x] Added mocked end-to-end worker startup/health/signal tests to repository for actual Node CI execution.
- [ ] Full Node 22 Actions workflow reported passing for latest revision (only Vercel check is confirmed; the GitHub workflow query exposes no run, Node integration tests pending).
- [ ] Always-on Docker host connected and public Coinbase streaming observed live.
- [ ] Upstream LEAN or Freqtrade installed/integrated/tested; neither is in active execution today.
- [ ] Tradier brokerage account connected / eligible full-market data or QuantConnect Cloud live algorithm activated.
- [ ] One reconciled paper stock/options/crypto signal-to-fill cycle under the new engine.
- [ ] Cutover gate: shared account-wide risk, kill switch, real fill timestamps and measured net P/L.

## October 16 follow-up — broker reliability and real-trade evidence
- [x] Diagnosed one actual EWZ fractional paper buy submitted at 2026-10-16T14:15:20Z and recorded as pending_new, not a verified fill
- [x] Diagnosed unfilled stock BUY submissions consuming daily entry quota
- [x] New quota distinguishes filled autonomous buys, canceled/rejected attempts and outstanding orders; pending risk blocks duplicates
- [x] Added equity-entry-quota regression tests (4 isolated cases passed)
- [x] Diagnosed 108 equity-risk-cycle HTTP 404 failures in production
- [x] Fractional monitor now uses shared Alpaca market clock with calendar fallback and endpoint-specific failure reporting
- [x] Added mock v2-clock-404 fallback regression test to source; GitHub Actions result not yet available
- [x] Diagnosed crypto research vetoes driven by tiny current UTC-day snapshot dollar-volume readings
- [x] Crypto scanner now uses median dollar volume of the last seven completed daily bars, requiring at least three days
- [x] Added crypto-liquidity regression tests (3 isolated cases passed)
- [x] New Overview trading-reality card integrates broker fill timeline with critical scheduler status
- [x] Dashboard script syntax validated in isolated JavaScript runtime
- [ ] Verify first subsequent equity-risk-cycle as COMPLETED in production during a stock market session
- [ ] Verify new crypto completed-bar liquidity diagnostics actually produce qualified candidates
- [ ] Verify post-fix orders are accepted and genuinely filled by Alpaca
- [ ] Full GitHub Actions CI run verified; workflow discovery returned no run for latest checked revision
- [ ] Browser/mobile UI screenshot verification performed

## Latest expansion — 2026-10-16
- [x] Broker fill history API: all paper asset classes, execution timestamps, partial fills, submission and rejection events
- [x] History UI: mobile-friendly sortable-by-time feed with asset and event filters, local timezone and UTC
- [x] Broker origin shown honestly as AI_TRADER or UNATTRIBUTED; auto-generated closes may not carry bot IDs
- [x] Crypto pretrade numerical market-quality review and optional bounded Gemini veto, with quant fallback explicitly labeled
- [x] Manual long call/put paper route: option quality, IV, spread, DTE and premium research plus optional Gemini veto
- [x] Crypto risk exit protection checks exact latest bot fill and ignores manually changed lots; duplicate sell detection added
- [x] Hourly archived crypto scanner near misses, instead of burning AI requests on every 15-minute no-setup cycle
- [x] Neon pretrade_research_audit table created via idempotent migration and schema verified
- [x] AI Research Journal API and Automation UI linked to actual saved research and order IDs
- [x] Exact HTTPS Alpaca paper host validation strengthened across stock, crypto, options and paper short routes
- [x] Dashboard session signing no longer falls back to the public repository login verifier
- [x] Login returns configuration error if server has no private HMAC signing key (CRON_SECRET or DASHBOARD_SESSION_SECRET)
- [x] Authentication security regression test added (full Node execution still requires CI verification)
- [x] 36 isolated JavaScript regression tests passed across 9 groups (not equivalent to full GitHub Actions CI)
- [ ] Broker fill history tested against live authenticated Alpaca production paper response
- [ ] New crypto Gemini review exercised with genuine qualifying production setup
- [ ] Full GitHub Actions job result verified
- [ ] Automatic options paper ENTRY worker (scheduled monitor currently only automates options exit management)
- [ ] Prospective model calibration/online learning with measured net outcomes; no claim of retrained neural networks

## Current development batch
- [x] Cost-aware shortlist ranking added to stock autonomous execution, prioritizing spread, freshness, relative strength, liquidity and modest historical evidence
- [x] Gemini receives transparent opportunity-rank notes; it remains advisory and cannot bypass risk gates
- [x] Regime-adjusted scanner threshold and existing held/open-order/cooldown filters preserved in revised ranking
- [x] Opportunity ranking unit tests and source-wire checks executed in isolated JS harness (8 checks passed)
- [x] Equity broker order policy: fractional simple DAY limit / whole-share broker brackets
- [x] App-managed paper fractional-equity monitor with strict autonomous-fill ownership matching
- [x] Stop -3%, target +6%, and close-window exit rules with 5-minute weekday monitoring
- [x] New independent `/api/equity-risk-cycle` scheduler, telemetry and health integration
- [x] Crypto two-slot diversification with total $50 paper momentum gross cap
- [x] Maximum two $25 filled crypto entries in rolling 24h, same-symbol anti-churn
- [x] Existing stablecoins excluded from momentum capacity and scoring
- [x] Crypto diagnostics updated to show two-slot capacity and real order-fill evidence
- [x] Broker Truth panel added to Automation workspace, fed by stock/crypto diagnostics and auto-refreshed on navigation
- [x] Cron telemetry rewritten to persist audit completion before sending HTTP response
- [x] Isolated mock test verified audit-complete-before-response ordering for successful and failed workers
- [x] Existing stock cycle legacy exits/EOD flatten now verify last filled broker order and exact position size before touching positions, preserving mixed/manual accounts
- [x] Authenticated broker order diagnostic endpoints retained and integrated
- [x] Unit tests added for crypto allocation, stock protection ownership and EOD rules
- [x] Mock-broker risk worker integration test created and one matching broker-only stop scenario executed in isolation
- [x] Source-level JS parse and deterministic helper checks executed via isolated JS harness (21 checks pass after final changes)
- [ ] Verify all CI test jobs through GitHub Actions (not established by deployment alone)
- [ ] Verify at least one new broker-accepted stock order and a filled paper trade
- [ ] Verify actual 5-minute fractional protection worker run next stock market session
- [ ] Verify actual second eligible crypto position with total notional <= $50
- [ ] Browser-based screenshot and mobile touch testing (not available in present tools)

## Additional development priorities
1. Measure actual broker fills and spread/fee-adjusted closed P/L before any risk scaling.
2. Validate the new hourly crypto-rejection evidence and compare candidate opportunity forecasts against later price movement before widening the tradeable strategy set.
3. Implement independently verified autonomous paper options CALL and PUT entries from the shadow router, preserving the $100 contract premium and hard risk gates.
4. Build an auditable strategy promotion system that requires forward out-of-sample data and cannot change production trading controls automatically on a tiny sample.
5. Verify first real broker transaction records and mobile usability of the trade timeline.
6. Do not switch to live-money execution until broker integration tests, loss controls, performance evidence and user-approved risk limits have been established.

## Known technical debt and follow-ups (priority order)
1. **P0 — Order acceptance:** Confirm Alpaca allows exact paper fractional `simple` DAY limit payload and verify filled status, no longer merely submitted.
2. **P0 — Protection limitation:** App-managed fractional stops are only checked periodically and are not guaranteed stop orders. Investigate supported broker-native coverage or stricter limits for any live-money product.
3. **P0 — Position ownership:** Introduce durable fill-based position ownership ledger to distinguish mixed manual/bot holdings across partially filled or combined lots.
4. **P1 — Database reliability:** Watch for further `cron_audit_save_failed` errors. Improve connection pooling and report incomplete audits separately from verified timeouts.
5. **P1 — Realized P/L:** Reconcile Alpaca fills and fees in a persistent per-trade execution ledger. Do not count AI BUY decisions as trades or unrealized gains as realized profits.
6. **P1 — Automated failure response:** Display a persistent warning if scheduled workers fail repeatedly or if broker rejects consecutive orders; optionally require operator review.
7. **P1 — Crypto quality:** Research cost-adjusted forward results and rejection distributions before expanding beyond the 2 x $25 paper caps.
8. **P2 — Dashboard:** Add sortable order journal, chronological fills, execution-price differences, filterable errors and responsive mobile review.
9. **P2 — Strategy validation:** Validate newly introduced cost-aware shortlist rank in shadow mode against prospective fills/outcomes; do not assume it improves returns. Extend per-strategy tracking, regime-aware evaluation, chronological walk-forward validation, calibrated costs and benchmark evidence.
10. **P2 — Documentation:** Keep README broker restrictions and current autonomous behavior synchronized with implementation.

## Verification notes
- Vercel `READY` and green deployment check do not verify an Alpaca fill.
- Previous Neon Decision Memory showed 31 `ORDER_REJECTED` stock outcomes with fractional bracket incompatibility and zero `ENTRY_SUBMITTED` at diagnosis time.
- Local isolated runtime checks executed against latest repository sources: 21 passing checks, dashboard and risk-worker JS parsing.
- Independent mock-broker paper stop test: bot-owned MSFT was submitted for close, unrelated manual AAPL was left untouched.
- Broker stock fill confirmation, end-to-end production risk-worker execution, and full GitHub Actions CI execution still require independent verification.
- The next stock-market session is required for end-to-end validation.
