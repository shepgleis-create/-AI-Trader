# AI Trader

Autonomous **paper-trading** research system using Alpaca market/trading APIs, Gemini for a constrained decision layer, and deterministic risk controls.

## What it does now

### Dashboard security
- Public static shell, but API/data/trade endpoints require a signed session.
- Login reuses the existing `CRON_SECRET`; no additional Vercel secret is required.
- Session cookie is HttpOnly, Secure, SameSite=Strict, and expires after 7 days.
- Scheduled cron execution remains protected with the Bearer `CRON_SECRET`.

### Market coverage
- Pulls Alpaca's active tradable U.S. equity universe dynamically.
- Considers major U.S. exchange listings instead of a hard-coded ticker list.
- Fast snapshot pass across the market.
- Liquidity/activity prefilter.
- Deep analysis of roughly 300 liquid/actionable names.
- Shows the strongest shortlist rather than pretending the visible table is the whole universe.

### Quantitative ranking
Candidate scoring includes:
- 20-day / 50-day trend
- 5-day / 20-day momentum
- RSI
- volume expansion
- proximity to recent highs
- ATR / short-term price risk
- realized volatility
- 20-day relative strength versus SPY
- average dollar liquidity
- SPY market-regime adjustment
- same-day advance/decline breadth
- multi-day market participation (% above 20-day / 50-day trends and median 20-day momentum)
- broad sector ETF leadership / laggards
- inferred sector proxy for each candidate
- 60-day beta versus SPY
- overnight gap and move-from-open behavior

### Market regime
SPY is used to classify the environment as:
- `RISK_ON`
- `NEUTRAL`
- `RISK_OFF`

The required entry score rises when the market environment is less favorable.

### Event context
Before a top candidate reaches Gemini, the system also checks:
- recent Alpaca news headlines
- headline event-risk terms
- corporate actions from Alpaca
- hard event-risk flags for especially dangerous situations

This is not yet a dedicated earnings-calendar feed. Earnings/guidance are detected from recent news when available.

### Gemini decision layer
Gemini 3.8 Flash reviews only a small pre-screened shortlist.

It receives:
- quant metrics
- market regime
- recent headlines
- corporate actions
- current positions
- cash / equity context

It can output `BUY` or `SKIP`, but **cannot bypass the deterministic risk engine**.

If Gemini is unavailable, a quant fallback can still make a paper decision.

### Hard risk controls
Current calibration rules:
- Paper endpoint only
- Max 3 open positions
- Max 30% gross portfolio exposure
- Daily loss kill switch at -2%
- 30-day drawdown circuit breaker at -5%
- Trailing-week loss circuit breaker at -4%
- Consecutive autonomous-loss lock at 3
- Open stop-defined risk budget capped at 1% of equity
- Regime-adjusted minimum score
- Minimum model conviction for Gemini entries
- Event-risk veto
- Liquidity floor
- ATR / volatility ceilings
- Market-stress lock for risk-off + very weak breadth
- Broad-market volatility stress lock
- Intraday chase protection for heavily extended names
- Gap-fade and extreme-gap vetoes
- High-beta veto and beta-based size reduction
- Sector-cluster concentration guard
- Calibration entry cap: $25
- No shorts
- No options
- No leverage-based sizing
- No averaging down

### Account-level circuit breakers
The autonomous cycle, AI decision preview, and manual paper execution test now share the same account-level protection layer:
- recent high-water equity / drawdown
- trailing-week return
- stop-defined open risk
- consecutive closed autonomous losses

If any account circuit breaker is active, new entries are blocked everywhere.

### Position sizing
Sizing uses:
- account equity
- cash
- ATR-based stop distance
- realized volatility adjustment
- hard $25 calibration cap

The cap is intentionally tiny until the execution path is proven.

### Intraday execution confirmation
Immediately before an entry, the selected symbol is rechecked on 15-minute data:
- session VWAP
- recent ~45-minute momentum
- same-session relative strength versus SPY

The order is rejected if the daily setup is breaking down intraday.

### Broker-side protection
New autonomous paper entries are submitted as price-capped Alpaca limit bracket orders where supported:
- limit entry capped slightly above the current ask/reference price
- attached stop-loss
- attached take-profit
- stale unfilled autonomous entries are canceled after 20 minutes

This is important because Vercel Hobby scheduling is not suitable for second-by-second risk management.

### Automation
On Vercel Pro, one weekday cron checks the autonomous cycle every 15 minutes from 13:00–21:59 UTC. A second weekday cron runs the Decision Memory outcome grader after the U.S. close. The endpoint exits immediately when Alpaca reports the market closed, which covers both U.S. daylight-saving and standard-time market hours without maintaining two seasonal schedules.

Each cycle:
1. checks Alpaca account / market state
2. checks kill switches
3. scans the market
4. builds event context
5. asks Gemini or uses quant fallback
6. applies the hard risk gate
7. plans or submits a bracket-protected paper order

Automatic execution remains disabled while:
`AUTO_TRADING_ENABLED=false`

Vercel functions are configured with a 60-second maximum duration so full-market scans and research endpoints have more room to finish.

### Portfolio exposure map
Open positions can be analyzed by:
- inferred sector ETF proxy
- sector correlation
- 60-day beta versus SPY
- position-weighted portfolio beta

This complements direct ticker-to-ticker correlation checks.

### Actual paper performance
The dashboard also reads Alpaca's real paper portfolio history and compares the account against SPY over the latest month:
- paper-account return
- SPY return
- excess return
- P/L dollars
- max drawdown
- Sharpe ratio

### Benchmark Lab
The Benchmark Lab compares AI Trader over the exact same overlapping daily dates against:
- SPY
- VTI
- a 60% VTI / 40% BND research benchmark

It reports:
- total return
- $10,000-equivalent ending value
- max drawdown
- annualized volatility
- Sharpe
- Sortino
- excess return versus each benchmark

When available, the bot return series prefers Alpaca's broker-reported portfolio-history profit/loss percentage series instead of relying only on raw equity changes.

### Research Evidence Gate
A fixed diagnostic gate prevents moving the research goalposts. It checks:
- minimum closed autonomous trade sample
- profit factor
- excess return versus SPY
- Sharpe versus SPY
- maximum drawdown
- observed entry slippage
- minimum benchmark-history length

The gate is diagnostic only. It does not enable live-money trading.

### Out-of-sample robustness lab
A separate research endpoint tests a grid of:
- regime-threshold offsets
- ATR stop-distance multipliers
- reward-to-risk targets

The historical window is split into a training section and a later unseen validation section. Parameters are ranked only on training performance, then their untouched validation results are displayed.

It also reports:
- percentage of tested configurations profitable in validation
- percentage beating SPY in validation
- median validation Sharpe
- the validation performance of the training-selected configuration

This still uses today's active/liquid universe and does not replay Gemini/news/intraday filters, so it remains a robustness screen rather than proof of future returns.

### Research backtest
The dashboard includes a walk-forward research test with:
- roughly one trading year
- daily bars
- next-day-open entries to reduce look-ahead
- slippage assumption
- max 3 positions
- ATR-based stop / target
- time-based exit
- SPY benchmark
- total return
- excess return vs SPY
- win rate
- average trade return
- profit factor
- max drawdown
- Sharpe ratio

Important limitation:
The current backtest uses today's active/liquid universe. This introduces survivorship and selection bias. It is useful for research and rejecting weak strategies, but it is not institutional-grade evidence of future returns.

### Confidence calibration
Closed autonomous paper trades are grouped by:
- Gemini confidence bucket
- scanner-score bucket
- Gemini versus quant fallback
- realized entry slippage

The system does not automatically retune thresholds from tiny samples. Research adaptation remains locked until at least 20 comparable closed trades are available.

### Decision Memory
The strategy now has a Postgres-ready persistent research-memory layer.

When a database connection is configured, it stores:
- autonomous and manual decision cycles
- BUY / SKIP decisions
- scanner candidates and compact feature snapshots
- readiness scores
- event context
- hard-risk results
- intraday veto results
- execution metadata
- the final stage where each decision ended

A weekday post-market outcome worker revisits stored candidates and records their 1-, 3-, and 5-trading-day returns. This allows skipped and vetoed candidates to be evaluated instead of only studying executed trades.

Decision Memory storage is best-effort and never bypasses or blocks the trading safety engine. If no supported Postgres connection variable exists, memory writes are skipped safely while the rest of the paper system continues.

The dashboard includes filter attribution for:
- decision stages
- deterministic hard-risk veto reasons
- intraday veto reasons
- selected versus skipped candidates
- readiness / event-risk segments

Supported database connection environment variables:
- `DATABASE_URL`
- `POSTGRES_URL`
- `POSTGRES_PRISMA_URL`
- `NEON_DATABASE_URL`

### Execution journal
Alpaca order history is used as the durable execution journal.

Future autonomous order IDs also encode the pre-trade reference quote, allowing the dashboard to estimate entry slippage after fills.

Autonomous order IDs encode:
- Gemini vs quant fallback
- scanner score
- model conviction

The dashboard also shows whether an order has broker-side protection legs and, for new autonomous orders, estimated entry slippage versus the pre-order quote.

Skipped decisions and candidate snapshots are now wired for durable persistence through Decision Memory once a Postgres database is connected.

## Required Vercel environment variables

- `ALPACA_API_KEY`
- `ALPACA_SECRET_KEY`
- `ALPACA_BASE_URL=https://paper-api.alpaca.markets`
- `GEMINI_API_KEY`
- `CRON_SECRET`
- `AUTO_TRADING_ENABLED=false` during calibration
- one supported Postgres connection variable if Decision Memory persistence is enabled

The application no longer requires `OPENAI_API_KEY`.

## What is still intentionally not enabled

- live-money trading
- options
- crypto
- short selling
- intraday high-frequency strategies
- large position sizes
- automatic scaling based on early wins

Those should only be considered after the paper system has a meaningful, reviewed record.

Never commit API keys or secrets to GitHub.
