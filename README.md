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
- broad sector ETF leadership / laggards

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

### Broker-side protection
New autonomous paper entries are submitted as Alpaca bracket orders where supported:
- entry
- attached stop-loss
- attached take-profit

This is important because Vercel Hobby scheduling is not suitable for second-by-second risk management.

### Automation
On Vercel Pro, one weekday cron now checks the autonomous cycle every 15 minutes from 13:00–21:59 UTC. The endpoint exits immediately when Alpaca reports the market closed, which covers both U.S. daylight-saving and standard-time market hours without maintaining two seasonal schedules.

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

### Actual paper performance
The dashboard also reads Alpaca's real paper portfolio history and compares the account against SPY over the latest month:
- paper-account return
- SPY return
- excess return
- P/L dollars
- max drawdown
- Sharpe ratio

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

### Execution journal
Alpaca order history is used as the durable execution journal.

Future autonomous order IDs also encode the pre-trade reference quote, allowing the dashboard to estimate entry slippage after fills.

Autonomous order IDs encode:
- Gemini vs quant fallback
- scanner score
- model conviction

The dashboard also shows whether an order has broker-side protection legs and, for new autonomous orders, estimated entry slippage versus the pre-order quote.

Skipped decisions are not yet durably persisted because the project currently has no database.

## Required Vercel environment variables

- `ALPACA_API_KEY`
- `ALPACA_SECRET_KEY`
- `ALPACA_BASE_URL=https://paper-api.alpaca.markets`
- `GEMINI_API_KEY`
- `CRON_SECRET`
- `AUTO_TRADING_ENABLED=false` during calibration

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
