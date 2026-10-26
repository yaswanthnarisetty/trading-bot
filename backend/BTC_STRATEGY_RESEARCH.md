# BTCUSD Delta Demo strategy research — 9 October 2026 IST

**Decision: no automatic BTC strategy is qualified.** This study does not predict future profit. It did not place an order. The HTTP trading route remains disabled, and the one-contract broker smoke from 8 October remains the only verified Demo round trip.

Run the read-only study from `backend/` with `node -r ts-node/register -r dotenv/config scripts/btcStrategyStudy.cjs`. Four strategy definitions are fixed in `src/services/BtcStrategyResearchService.ts`: Donchian breakout with EMA trend, EMA pullback, trend continuation, and range reversion. The study uses actual Delta Demo BTCUSD candles, requiring complete contiguous bars. Entries occur at the **next** bar's open after a decision based on completed bars. Stops win ambiguous intrabar stop/target races; gaps through a stop use the worse opening price. One position may be open at a time.

For 5-minute and 15-minute bars, the 90-day sample (10 July–8 October UTC) contains 25,920 and 8,640 contiguous bars respectively. The first 50% is training, the next 25% validation, and the final 25% holdout. Selection considers only training and validation. Since no candidate passed both, **the final holdout was not inspected**. Starting equity was the signed Demo account's $158.67739965. Position size is bounded by 0.5% estimated loss including costs and 1× account equity in notional. The replay halts new entries after 2% daily realized loss, limits entries to two per UTC day, and adds a three-bar cooldown after a loss. It subtracts a 30-basis-point round-trip allowance for taker fees, slippage, and possible funding; 60-basis-point stress testing is required before final holdout admission. The allowance is an estimate, not a cap on actual exchange costs or gap loss.

| Fixed candidate | 5m validation, 30 bp | 15m validation, 30 bp | Outcome |
| --- | ---: | ---: | --- |
| Donchian trend | 44 trades, −$13.82 | 28 trades, −$5.06 | Rejected |
| EMA pullback | 42 trades, −$13.08 | 30 trades, −$7.27 | Rejected |
| Trend continuation | 45 trades, −$12.53 | 38 trades, −$9.38 | Rejected |
| Range reversion | 34 trades, −$7.90 | 10 trades, −$2.92 | Rejected |

At zero assumed cost in validation, seven of eight candidate/timeframe combinations still lost. Five-minute range reversion alone gained $1.16 at zero cost, but lost $7.90 with the 30 bp allowance. This is not merely a fee-model artifact; most of the proposed signals lacked a robust gross edge.

An **exploratory, separate** 180-day 1-hour study used 4,320 contiguous bars. The Donchian candidate lost $0.77 over six training trades, then gained $0.32 over five validation trades at 30 bp. It fails the positive-training and minimum-sample requirements. Other 1-hour candidates lost during validation. The small $158.68 account also could not afford one contract under the 0.5% risk cap for many 1-hour signals. The final 1-hour quarter was not evaluated.

The broker path now also requires a Delta Demo BTCUSD order book updated within 10 seconds, a bid below the ask, spread at most 10 bp, and at least five contracts and three times the intended size at the top of **both** sides. It verifies the book against the fresh mark price before durable intent creation and immediately before the sole order submission attempt. It retains the durable unique intent, 0.5% estimated risk, 1× notional, 2% daily stop, attached stop/target prices, reduce-only close, and exchange order/fill/position reconciliation. The book check prevents visibly wide or thin market orders; it does not guarantee a fill price or profit.

Historical candles cannot reconstruct past order-book depth, exact slippage, exchange funding, liquidation behavior, or every intrabar path. Backtest results are therefore screening evidence, not live-performance evidence. To reconsider automatic Demo trading, formulate a **new** hypothesis without using the untouched final quarter for tuning; demand positive training and validation across two timeframes after costs and 60 bp stress, sufficient trades, and controlled drawdown; then evaluate the final holdout once. The existing strategy gate must remain closed until those requirements are met and the live signal, backtest rules, and broker exits use the same strategy definition.

Exchange references: [Delta API candle and book endpoints](https://docs.delta.exchange/), [Delta India BTC perpetual contract fees and funding interval](https://prod-mobile-india.delta.exchange/contracts).
