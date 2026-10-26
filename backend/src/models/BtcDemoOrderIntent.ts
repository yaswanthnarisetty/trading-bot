import { Schema, model } from "mongoose";

export type BtcDemoIntentStatus = "PREPARED" | "ORDER_ACKNOWLEDGED" | "FILLED_PROTECTED" |
  "CLOSE_REQUESTED" | "CANCELLED_UNFILLED" | "CLOSED_CONFIRMED" | "ATTENTION";

export interface BtcDemoOrderIntent {
  clientOrderId: string;
  activeSlot?: string | null;
  dailySlot?: string | null;
  status: BtcDemoIntentStatus;
  productId: number;
  side: "LONG" | "SHORT";
  sizeContracts: number;
  referencePriceUsd: number;
  stopUsd: number;
  targetUsd: number;
  tickSize: number;
  contractValueBtc: number;
  riskBudgetUsd: number;
  costAllowanceUsd: number;
  validationId: string;
  equityAtEntryUsd: number;
  orderId?: string | null;
  closeClientOrderId?: string | null;
  closeOrderId?: string | null;
  filledContracts?: number;
  averageFillPriceUsd?: number | null;
  averageExitPriceUsd?: number | null;
  entryFillIds?: string[];
  exitFillIds?: string[];
  realizedPnlUsd?: number | null;
  attentionReason?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const schema = new Schema<BtcDemoOrderIntent>({
  clientOrderId: { type: String, required: true, unique: true },
  activeSlot: { type: String, default: "BTCUSD:DELTA_DEMO" },
  dailySlot: { type: String, default: null },
  status: { type: String, required: true, enum: ["PREPARED", "ORDER_ACKNOWLEDGED", "FILLED_PROTECTED", "CLOSE_REQUESTED",
    "CANCELLED_UNFILLED", "CLOSED_CONFIRMED", "ATTENTION"] },
  productId: { type: Number, required: true },
  side: { type: String, required: true, enum: ["LONG", "SHORT"] },
  sizeContracts: { type: Number, required: true },
  referencePriceUsd: { type: Number, required: true },
  stopUsd: { type: Number, required: true },
  targetUsd: { type: Number, required: true },
  tickSize: { type: Number, required: true },
  contractValueBtc: { type: Number, required: true },
  riskBudgetUsd: { type: Number, required: true },
  costAllowanceUsd: { type: Number, required: true },
  validationId: { type: String, required: true },
  equityAtEntryUsd: { type: Number, required: true },
  orderId: { type: String, default: null },
  closeClientOrderId: { type: String, default: null },
  closeOrderId: { type: String, default: null },
  filledContracts: { type: Number, default: 0 },
  averageFillPriceUsd: { type: Number, default: null },
  averageExitPriceUsd: { type: Number, default: null },
  entryFillIds: { type: [String], default: [] },
  exitFillIds: { type: [String], default: [] },
  realizedPnlUsd: { type: Number, default: null },
  attentionReason: { type: String, default: null },
}, { collection: "btc_demo_order_intents", timestamps: true });

schema.index({ activeSlot: 1 }, { unique: true, partialFilterExpression: { activeSlot: { $type: "string" } } });
schema.index({ dailySlot: 1 }, { unique: true, partialFilterExpression: { dailySlot: { $type: "string" } } });
schema.index({ status: 1, updatedAt: 1 });

export const BtcDemoOrderIntentModel = model<BtcDemoOrderIntent>("BtcDemoOrderIntent", schema);
