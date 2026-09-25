import { model } from "mongoose";
import { reservationStateSchema } from "@trading-bot/shared";
import { executionSchema, idField, identityIndexes, moneyField, unitsField } from "./executionSupport";

export const RiskReservationSchema = executionSchema({
  reservationId: idField(), intentId: idField(), strategyInstanceId: idField(),
  // Quantity-backed authorization for CLOSE, not a fabricated monetary risk hold.
  kind: { type: String, enum: ["CLOSE_QUANTITY"], immutable: true },
  // Avoid applying an implicit [] through an immutable setter during hydration.
  instrumentKeys: { type: [String], default: undefined, required: true, immutable: true },
  state: { type: String, enum: reservationStateSchema.options, required: true },
  initialMarginMinor: { ...moneyField(), immutable: true }, initialExposureMinor: { ...moneyField(), immutable: true },
  remainingMarginMinor: moneyField(), remainingExposureMinor: moneyField(),
  positionSlots: unitsField(), policyVersion: unitsField(),
}, "execution_reservations");
identityIndexes(RiskReservationSchema, "reservationId");
RiskReservationSchema.index({ accountId: 1, intentId: 1 }, { unique: true });
RiskReservationSchema.pre("validate", function () {
  const margin = this.get("remainingMarginMinor"), initialMargin = this.get("initialMarginMinor");
  const exposure = this.get("remainingExposureMinor"), initialExposure = this.get("initialExposureMinor");
  if ((typeof margin === "number" && typeof initialMargin === "number" && margin > initialMargin)
    || (typeof exposure === "number" && typeof initialExposure === "number" && exposure > initialExposure)) {
    this.invalidate("remainingMarginMinor", "Remaining hold exceeds authorized reservation");
  }
  const state = this.get("state");
  if (typeof state === "string" && ["CONSUMED", "RELEASED"].includes(state) && (this.get("remainingMarginMinor") !== 0 || this.get("remainingExposureMinor") !== 0)) {
    this.invalidate("state", "Terminal reservation must have zero remaining holds");
  }
});
export const RiskReservationModel = model("ExecutionRiskReservation", RiskReservationSchema);
