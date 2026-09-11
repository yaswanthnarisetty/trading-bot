# Trading Bot

An automated options trading system for Indian equity index markets (NIFTY, BANKNIFTY, FINNIFTY) and BTC perpetual futures, powered by an LLM-driven signal engine with multi-layer risk management.

---

## Overview

The system runs a continuous signal loop that fetches live market data from Zerodha Kite (equities/options) and Delta Exchange (crypto), computes technical indicators and options Greeks, consults a GPT-4o-mini analyst for directional signals, and executes paper trades or live orders with automated entry/exit management.

**Key capabilities:**
- LLM-based signal generation for NIFTY/BANKNIFTY/FINNIFTY credit spreads (Bull Put Spread / Bear Call Spread)
- BTC perpetual long/short trading via Delta Exchange
- Full backtesting engine with slippage modeling
- Real-time WebSocket dashboard with Greeks, IV rank, support/resistance, and P&L
- Multi-layer risk guard (confidence gates, ATR filters, daily loss limits, RSI/PCR checks)
- Paper trading mode with live and mock data support

---

## Architecture

```
trading-bot/
├── backend/          # Express + TypeScript API + signal engine
│   └── src/
│       ├── config/       # Constants, assets, holidays
│       ├── db/           # MongoDB connection & indexes
│       ├── middleware/   # Auth, error handling
│       ├── models/       # Mongoose schemas
│       ├── routes/       # REST API routes
│       ├── services/     # Core business logic
│       ├── types/        # Shared internal types
│       └── utils/        # Indicators, Greeks math, market hours, logger
└── frontend/         # Next.js 16 dashboard
    ├── app/              # Pages (dashboard, backtest, BTC, performance, settings)
    ├── components/       # UI panels (signals, positions, Greeks, IV, S/R, charts)
    ├── context/          # AppContext (global state)
    ├── hooks/            # useWebSocket, useSessionTimer
    └── lib/              # API client
```

---

## Backend Services

### Signal Engine
- **SignalLoopService** — Main tick loop (every 5 minutes). Fetches candles, computes indicators, calls LLM, applies risk guard, executes paper trades.
- **LLMService** — Two-stage LLM pipeline: Primary Analyst (GPT-4o-mini) generates a signal; a Verifier runs on high-confidence signals as a second opinion. System prompts are finely tuned for Indian index options.
- **IndicatorService** — Computes RSI, EMA alignment, volume ratio, regime detection, ATR, PCR from OHLCV data.
- **GreeksEngine** — Computes Delta, Gamma, Theta, Vega, IV Rank, and expected move using Black-Scholes.
- **StrategySelector** — Selects strike and spread width for Bull Put Spread / Bear Call Spread based on signal and IV.
- **RiskGuardService** — Pre-trade risk filter: confidence threshold, max positions, daily loss limit, ATR volatility gate, RSI/PCR entry filters, opening-block (skip first 15 min), Friday/pre-holiday gap risk.

### Position & Trade Management
- **PaperTradeService** — Opens, tracks, and closes paper positions. Handles lot sizing (risk-based: 4% of capital per trade).
- **PositionMonitorService** — Fast-polling monitor (every 5 seconds) for stop-loss (50% of max loss), take-profit (50% of max credit), time exit (60 min), directional stop (3× ATR), and EOD forced close at 15:20 IST.
- **BacktestService** — Full historical backtest on Kite OHLCV data with same indicator stack, LLM-free signal replay, slippage model (1.5 pts/leg), and configurable risk parameters.
- **NewsSentimentService** — Fetches macro news sentiment as context for the LLM.

### Crypto Engine (BTC)
- **CryptoSignalService** — Generates LONG/SHORT signals for BTC perpetuals.
- **CryptoMonitorService** — Monitors open BTC positions with ATR-based SL/TP (1.5× / 3.0× ATR, 2:1 R:R).
- **CryptoTradingService** — Opens/closes BTC positions with risk-based sizing.
- **DeltaService** — Delta Exchange API integration for live BTC trading.

### Infrastructure
- **KiteService** — Zerodha Kite API integration (market data, option chain, OHLCV history).
- **WebSocketService** — Real-time push to frontend (signals, positions, P&L updates).
- **MockDataService** — Synthetic market data for offline/dev mode.

---

## API Routes

| Route | Description |
|---|---|
| `POST /api/session/start` | Start a monitoring session |
| `POST /api/session/stop` | Stop the session |
| `GET /api/signals` | Recent signal history |
| `GET /api/positions` | Open and closed positions |
| `GET /api/performance` | Equity curve and win rate stats |
| `POST /api/backtest/run` | Run a historical backtest |
| `GET /api/assets` | Supported assets list |
| `GET /api/kite/status` | Kite connection status |
| `POST /api/auth/login` | JWT authentication |
| `GET /api/crypto/*` | BTC session, positions, signals |

---

## Frontend Pages

- **Dashboard** — Live signal card, active positions table, Greeks panel, IV panel, indicator panel, support/resistance panel, signal history feed, WebSocket connection status.
- **Backtest** — Configure and run backtests by asset/date range/capital; view results inline.
- **BTC** — BTC perpetual positions and signal history.
- **Performance** — Equity curve chart and win-rate chart.
- **Settings** — Kite API credentials and session configuration.

---

## Supported Assets

| Asset | Lot Size | Expiry Day | Exchange |
|---|---|---|---|
| NIFTY | 65 | Wednesday | NFO |
| BANKNIFTY | 30 | Wednesday | NFO |
| FINNIFTY | 60 | Wednesday | NFO |
| BTCUSD | — | Perpetual | DELTA |

---

## Trading Rules (MVP-1)

- Strategies: **Bull Put Spread** (bullish) or **Bear Call Spread** (bearish) only. No naked options.
- HOLD is emitted when direction is unclear or risk guard blocks entry.
- Max 3 open positions at a time; max 3 new trades per calendar day.
- Max daily drawdown: 2% of capital before trading halts.
- No new positions after 15:20 IST; all positions force-closed by 15:30 IST.
- First 15 minutes of session (9:15–9:30 IST) blocked for new entries (indicator warmup).

### Exit Logic
| Trigger | Threshold |
|---|---|
| Take Profit | 50% of max credit received |
| Stop Loss | 50% of max possible loss |
| Time Exit | 60 minutes holding time |
| Directional Stop | Underlying moves 3× ATR against spread |
| EOD Close | 15:20 IST forced exit |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, TypeScript, Express |
| Database | MongoDB (Mongoose) |
| LLM | OpenAI GPT-4o-mini |
| Frontend | Next.js 16, React 18, Tailwind CSS, Recharts |
| Broker (Equities) | Zerodha Kite Connect API |
| Broker (Crypto) | Delta Exchange API |
| Real-time | WebSocket (ws) |
| Auth | JWT |
| Validation | Zod |
| Logging | Winston |

---

## Environment Variables

### Backend (`.env`)
```
PORT=4000
MONGODB_URI=
OPENAI_API_KEY=
KITE_API_KEY=
KITE_ACCESS_TOKEN=
DELTA_API_KEY=
DELTA_API_SECRET=
JWT_SECRET=
PAPER_CAPITAL=200000
USE_MOCK=false
```

### Frontend (`.env`)
```
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_WS_URL=ws://localhost:4000
```

---

## Running Locally

```bash
# Backend
cd backend
npm install
npm run dev        # ts-node hot-reload on port 4000

# Frontend
cd frontend
npm install
npm run dev        # Next.js dev server on port 3000
```

Production backend runs on `https://app.yaswanthnarisetty.com`.

---

## Backtesting

Run via the dashboard UI or directly via `POST /api/backtest/run`:

```json
{
  "asset": "NIFTY",
  "from": "2026-01-01",
  "to": "2026-03-31",
  "interval": "5minute",
  "initialCapital": 200000,
  "riskPerTradePct": 4,
  "targetProfitPct": 0.5,
  "stopLossPct": 0.5,
  "maxHoldingBars": 12
}
```

The backtest uses the same indicator stack and risk guard as live trading. Signals are computed bar-by-bar without look-ahead. Slippage is modeled at 1.5 pts/leg (3 pts round-trip per leg).

---

## Key Design Decisions

- **LLM as analyst, not executor** — The LLM interprets pre-computed indicators and outputs a structured signal (strategy, strikes, confidence, risk flags). It never computes math or touches trade execution.
- **Two-stage LLM** — A Verifier is invoked on high-confidence signals as a second opinion to reduce false positives.
- **Risk guard is a hard gate** — All RiskGuard decisions are deterministic code, not LLM-based. The LLM can never override risk limits.
- **Paper mode default** — All trades are paper by default. Live execution requires explicit broker credentials and is opt-in.
- **Crypto is fully isolated** — BTC engine, models, and routes are separate from the index options engine.
