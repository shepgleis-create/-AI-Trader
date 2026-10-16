# AI Trader — Development checklist
Updated: 2026-10-15
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
