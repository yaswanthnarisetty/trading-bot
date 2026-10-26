export interface BtcDemoProduct {
  id: number;
  symbol: "BTCUSD";
  contractValueBtc: number;
  tickSize: number;
}

export type BtcDemoPlan =
  | { eligible: false; reason: string; riskBudgetUsd: number; minimumContractLossUsd: number | null }
  | { eligible: true; side: "LONG" | "SHORT"; productId: number; contractCount: number;
      entryReferenceUsd: number; stopReferenceUsd: number; takeProfitReferenceUsd: number;
      notionalUsd: number; riskBudgetUsd: number; estimatedLossAtStopUsd: number;
      costAllowanceUsd: number; warning: string };

/** A conservative, read-only sizing preview. This does not authorize an order. */
export function planBtcDemoTrade(input: {
  side: "LONG" | "SHORT"; entryPrice: number; atr: number; equityUsd: number;
  product: BtcDemoProduct; openPositionCount: number; activeOrderCount: number;
}): BtcDemoPlan {
  const { side, entryPrice, atr, equityUsd, product, openPositionCount, activeOrderCount } = input;
  const riskBudgetUsd = Number.isFinite(equityUsd) && equityUsd > 0 ? equityUsd * 0.005 : 0;
  const blocked = (reason: string, minimumContractLossUsd: number | null = null): BtcDemoPlan =>
    ({ eligible: false, reason, riskBudgetUsd, minimumContractLossUsd });
  if (!Number.isFinite(equityUsd) || equityUsd <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0 ||
      !Number.isFinite(atr) || atr <= 0 || !Number.isFinite(product.contractValueBtc) || product.contractValueBtc <= 0 ||
      !Number.isFinite(product.tickSize) || product.tickSize <= 0 || !Number.isSafeInteger(product.id) || product.id <= 0)
    return blocked("INVALID_ACCOUNT_OR_MARKET_EVIDENCE");
  if (openPositionCount !== 0 || activeOrderCount !== 0)
    return blocked("EXCHANGE_EXPOSURE_OR_ORDER_PRESENT");
  // 1.5 ATR, rounded away from entry to exchange tick. The 30 bp round-trip
  // allowance covers estimated fees and slippage for preview, not gap risk.
  const stopDistance = Math.max(atr * 1.5, product.tickSize);
  const rawStop = side === "LONG" ? entryPrice - stopDistance : entryPrice + stopDistance;
  const stopReferenceUsd = side === "LONG"
    ? Math.floor(rawStop / product.tickSize) * product.tickSize
    : Math.ceil(rawStop / product.tickSize) * product.tickSize;
  if (stopReferenceUsd <= 0) return blocked("INVALID_STOP_PRICE");
  const takeProfitReferenceUsd = side === "LONG"
    ? Math.floor((entryPrice + stopDistance * 2) / product.tickSize) * product.tickSize
    : Math.ceil((entryPrice - stopDistance * 2) / product.tickSize) * product.tickSize;
  if (takeProfitReferenceUsd <= 0) return blocked("INVALID_TARGET_PRICE");
  const lossPerContract = Math.abs(entryPrice - stopReferenceUsd) * product.contractValueBtc;
  const costPerContract = entryPrice * product.contractValueBtc * 0.003;
  const minimumContractLossUsd = lossPerContract + costPerContract;
  const byRisk = Math.floor(riskBudgetUsd / minimumContractLossUsd);
  const byNotional = Math.floor(equityUsd / (entryPrice * product.contractValueBtc));
  const contractCount = Math.min(byRisk, byNotional);
  if (contractCount < 1) return blocked("MINIMUM_CONTRACT_EXCEEDS_RISK_OR_NOTIONAL_CAP", minimumContractLossUsd);
  return {
    eligible: true, side, productId: product.id, contractCount,
    entryReferenceUsd: entryPrice, stopReferenceUsd, takeProfitReferenceUsd,
    notionalUsd: entryPrice * product.contractValueBtc * contractCount,
    riskBudgetUsd, estimatedLossAtStopUsd: minimumContractLossUsd * contractCount,
    costAllowanceUsd: costPerContract * contractCount,
    warning: "Sizing estimate only. Exchange fills, fees, slippage, funding, gaps and liquidation can change actual loss.",
  };
}

/** Daily Demo experiment: the prior completed day's extreme is the stop anchor. */
export function planBtcPriorDayTrade(input: {
  side: "LONG" | "SHORT"; entryPrice: number; stopReferenceUsd: number; equityUsd: number;
  product: BtcDemoProduct; openPositionCount: number; activeOrderCount: number;
}): BtcDemoPlan {
  const { side, entryPrice, stopReferenceUsd, equityUsd, product,
    openPositionCount, activeOrderCount } = input;
  const riskBudgetUsd = Number.isFinite(equityUsd) && equityUsd > 0 ? equityUsd * 0.005 : 0;
  const blocked = (reason: string, minimumContractLossUsd: number | null = null): BtcDemoPlan =>
    ({ eligible: false, reason, riskBudgetUsd, minimumContractLossUsd });
  if (!Number.isFinite(equityUsd) || equityUsd <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0 ||
      !Number.isFinite(stopReferenceUsd) || stopReferenceUsd <= 0 ||
      !Number.isSafeInteger(product.id) || product.id <= 0 || product.symbol !== "BTCUSD" ||
      !Number.isFinite(product.contractValueBtc) || product.contractValueBtc <= 0 ||
      !Number.isFinite(product.tickSize) || product.tickSize <= 0)
    return blocked("INVALID_ACCOUNT_OR_MARKET_EVIDENCE");
  if (openPositionCount !== 0 || activeOrderCount !== 0)
    return blocked("EXCHANGE_EXPOSURE_OR_ORDER_PRESENT");
  const tick = product.tickSize;
  const stop = Number(((side === "LONG" ? Math.floor(stopReferenceUsd / tick)
    : Math.ceil(stopReferenceUsd / tick)) * tick).toFixed(8));
  if (!(side === "LONG" ? stop < entryPrice : stop > entryPrice))
    return blocked("PRIOR_DAY_STOP_CROSSED");
  const distance = Math.abs(entryPrice - stop);
  const rawTarget = entryPrice + (side === "LONG" ? 2 : -2) * distance;
  const target = Number(((side === "LONG" ? Math.floor(rawTarget / tick)
    : Math.ceil(rawTarget / tick)) * tick).toFixed(8));
  if (target <= 0 || !(side === "LONG" ? target > entryPrice : target < entryPrice))
    return blocked("INVALID_TARGET_PRICE");
  const costPerContract = entryPrice * product.contractValueBtc * 0.003;
  const minimumContractLossUsd = distance * product.contractValueBtc + costPerContract;
  const contractCount = Math.min(Math.floor(riskBudgetUsd / minimumContractLossUsd),
    Math.floor(equityUsd / (entryPrice * product.contractValueBtc)));
  if (!Number.isSafeInteger(contractCount) || contractCount < 1)
    return blocked("MINIMUM_CONTRACT_EXCEEDS_RISK_OR_NOTIONAL_CAP", minimumContractLossUsd);
  return { eligible: true, side, productId: product.id, contractCount,
    entryReferenceUsd: entryPrice, stopReferenceUsd: stop, takeProfitReferenceUsd: target,
    notionalUsd: entryPrice * product.contractValueBtc * contractCount,
    riskBudgetUsd, estimatedLossAtStopUsd: minimumContractLossUsd * contractCount,
    costAllowanceUsd: costPerContract * contractCount,
    warning: "Demo estimate only. A gap, slippage, fees, funding or liquidation can exceed the stop budget.",
  };
}
