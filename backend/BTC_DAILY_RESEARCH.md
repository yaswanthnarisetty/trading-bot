# BTC daily-candle research — 13 October 2026 IST

This is a read-only study of a fixed daily-candle hypothesis, not a claim that the video's trades can be reproduced. The video describes daily decisions and risk rules but does not provide an executable entry algorithm. This study explicitly tests a 20-day breakout with EMA20/50 trend alignment. At the user's request, a separate **experimental Delta Demo forward trial** can submit automatic orders using this rule when `BTC_DEMO_AUTO_TRADING=ENABLED`; it is not a historically validated strategy and never targets production Delta.

Run from `backend/`:

```sh
node -r ts-node/register -r dotenv/config scripts/btcDailyStudy.cjs
```

The script requests 730 completed UTC BTCUSD daily candles from Delta Demo, validates continuity and OHLC values, and reports training and validation at estimated 30- and 60-basis-point round-trip costs. The last quarter stays untouched unless the earlier partitions pass the predefined gate. It never calls an order endpoint. Delta's [candle API](https://docs.delta.exchange/) supports `1d` and a maximum of 2,000 candles per response.

The backtest enters at the next day's open, at most once per UTC day. A long stop is below the prior day's low by 0.1 ATR; a short stop is above the prior day's high. The target is 2R, the maximum hold is five days, and three consecutive losses pause new entries for three days. Size is limited by 0.5% estimated stop loss including assumed round-trip costs and by 1× account equity in notional. One position is open at a time. Ambiguous daily bars hit the stop first; gaps through a stop use the worse opening price. Actual loss may exceed the estimate.

On 13 October, Delta Demo returned **213 completed daily candles** (13 March–11 October 2026 UTC), short of the predeclared 730-day sample. The signed Demo equity was **$158.67739965**. The available training partition produced five breakout signals, but all five required more equity than the 0.5% one-contract risk budget permits. The cheapest observed one-contract signal needed approximately **$332.53** of equity at the 30-basis-point allowance, or **$370.81** at 60 basis points; that is a sizing calculation, not a funding recommendation. The validation partition produced no signals. There were **zero qualifying trades**, so no return, win rate, or profit factor can be inferred. The final quarter was not evaluated.

Delta India's production public candles returned a longer history, but their overlapping BTCUSD daily OHLC values differed from Demo candles. They are not silently substituted into this Demo execution study. The Demo forward trial is an experiment despite the failed historical gate. Its outcomes must be recorded and reviewed before considering any production use; broker stop/target triggering also needs direct verification. The old intraday BTC execution route remains closed.
