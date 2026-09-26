import { ReconciliationRecordSchema } from "../models/ReconciliationRecord";
import { ReconciliationLinkSchema } from "../models/ReconciliationLink";
import type { Connection } from "mongoose";
import { TradingAccountSchema } from "../models/TradingAccount";
import { StrategySignalSchema } from "../models/StrategySignal";
import { OrderIntentSchema } from "../models/OrderIntent";
import { RiskReservationSchema } from "../models/RiskReservation";
import { BrokerOrderSchema } from "../models/BrokerOrder";
import { FillSchema } from "../models/Fill";
import { PositionSchema } from "../models/Position";
import { TradingEventSchema } from "../models/TradingEvent";

export const baseExecutionSchemas = {
  TradingAccount: TradingAccountSchema, StrategySignal: StrategySignalSchema,
  OrderIntent: OrderIntentSchema, RiskReservation: RiskReservationSchema,
  BrokerOrder: BrokerOrderSchema, Fill: FillSchema, Position: PositionSchema, TradingEvent: TradingEventSchema,
} as const;
export const reconciliationSchemas = { ReconciliationRecord: ReconciliationRecordSchema, ReconciliationLink: ReconciliationLinkSchema } as const;
export const executionSchemas = { ...baseExecutionSchemas, ...reconciliationSchemas } as const;
export type ExecutionIndexGroup = "BASE" | "RECONCILIATION" | "ALL";
export function schemasForIndexGroup(group: ExecutionIndexGroup) {
  if (group === "BASE") return baseExecutionSchemas;
  if (group === "RECONCILIATION") return reconciliationSchemas;
  if (group === "ALL") return executionSchemas;
  throw new Error("INVALID_EXECUTION_INDEX_GROUP");
}
export type ExecutionEntity = keyof typeof executionSchemas;

/** Explicit connection; no environment loading, DB connection, worker or auto-index side effects. */
export function executionModels(connection: Connection) {
  return Object.fromEntries(Object.entries(executionSchemas).map(([name, schema]) =>
    [name, connection.models[`Execution${name}`] ?? connection.model(`Execution${name}`, schema)])) as
    Record<ExecutionEntity, ReturnType<Connection["model"]>>;
}

/** Explicit provisioning only. createIndexes never drops legacy or existing indexes. */
export async function createExecutionIndexes(connection: Connection, group: ExecutionIndexGroup = "ALL"): Promise<void> {
  if (connection.readyState !== 1) throw new Error("PERSISTENCE_NOT_READY");
  const models = executionModels(connection);
  for (const name of Object.keys(schemasForIndexGroup(group)) as ExecutionEntity[]) await models[name].createIndexes();
}
