# AI Trader

A cloud-hosted autonomous paper-trading bot using Alpaca for brokerage/data and Gemini for the LLM decision layer.

## Current stage

- Alpaca paper account connection
- Quantitative market scanner
- Gemini 3.8 Flash decision layer
- Quant fallback if Gemini is unavailable
- Guarded paper-order execution
- Scheduled weekday automation
- Hard paper-only safety lock

## Required Vercel environment variables

- `ALPACA_API_KEY`
- `ALPACA_SECRET_KEY`
- `ALPACA_BASE_URL` — use `https://paper-api.alpaca.markets`
- `GEMINI_API_KEY`
- `CRON_SECRET`
- `AUTO_TRADING_ENABLED` — keep `false` until paper execution is verified

The application no longer requires the OpenAI API.

Never commit API keys or secrets to GitHub.
