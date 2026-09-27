# AI Trader

Autonomous **paper-trading** research system using Alpaca market/trading APIs, Gemini for a constrained decision layer, and deterministic risk controls.

## What it does now

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
- Regime-adjusted minimum score
- Minimum model conviction for Gemini entries
- Event-risk veto
- Liquidity floor
- ATR / volatility ceilings
- Calibration entry cap: $25
- No shorts
- No options
- No leverage-based sizing
- No averaging down

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
Three separate weekday cron windows call the autonomous cycle:
- 15:00 UTC
- 17:30 UTC
- 19:00 UTC

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

Autonomous order IDs encode:
- Gemini vs quant fallback
- scanner score
- model conviction

The dashboard also shows whether an order has broker-side protection legs.

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
