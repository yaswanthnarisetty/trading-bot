import { Schema, model } from "mongoose";

export interface BtcDemoAutoControl {
  key: "BTCUSD:DELTA_DEMO";
  paused: boolean;
  updatedAt?: Date;
}

const schema = new Schema<BtcDemoAutoControl>({
  key: { type: String, required: true, unique: true, enum: ["BTCUSD:DELTA_DEMO"] },
  paused: { type: Boolean, required: true, default: false },
}, { collection: "btc_demo_auto_control", timestamps: true });

export const BtcDemoAutoControlModel = model<BtcDemoAutoControl>("BtcDemoAutoControl", schema);
