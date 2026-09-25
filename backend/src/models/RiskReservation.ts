import { model, Schema } from "mongoose";
import { entryAdmissionSchema } from "../domain/entryRisk";
import { reservationStateSchema } from "@trading-bot/shared";
import { executionSchema, idField, identityIndexes, moneyField, unitsField, writeOnceFields } from "./executionSupport";

export const RiskReservationSchema = executionSchema({
  reservationId: idField(), intentId: idField(), strategyInstanceId: idField(),
  // Quantity-backed authorization for CLOSE, not a fabricated monetary risk hold.
  kind: { type: String, enum: ["CLOSE_QUANTITY", "ENTRY_RISK"], immutable: true },
  entryAdmission: { type: Schema.Types.Mixed, immutable: true },
  // Avoid applying an implicit [] through an immutable setter during hydration.
  instrumentKeys: { type: [String], default: undefined, required: true, immutable: true },
  state: { type: String, enum: reservationStateSchema.options, required: true },
  initialMarginMinor: { ...moneyField(), immutable: true }, initialExposureMinor: { ...moneyField(), immutable: true },
  remainingMarginMinor: moneyField(), remainingExposureMinor: moneyField(),
  positionSlots: unitsField(), policyVersion: unitsField(),
}, "execution_reservations");
writeOnceFields(RiskReservationSchema, ["kind", "entryAdmission"]);
identityIndexes(RiskReservationSchema, "reservationId");
RiskReservationSchema.index({ accountId: 1, intentId: 1 }, { unique: true });
RiskReservationSchema.pre("validate", function () {
  if (this.get("kind") === "ENTRY_RISK") {
    if (!entryAdmissionSchema.safeParse(this.get("entryAdmission")).success) this.invalidate("entryAdmission", "Missing entry admission identity");
    const risk = this.get("initialExposureMinor");
    if (typeof risk !== "number" || !(risk > 0) || this.get("state") !== "HELD" || this.get("positionSlots") !== 1
      || ["initialMarginMinor", "remainingMarginMinor", "remainingExposureMinor"].some(key => this.get(key) !== risk))
      this.invalidate("state", "ENTRY risk and slot remain fully held until settlement is implemented");
  } else if (this.get("entryAdmission") !== undefined) this.invalidate("entryAdmission", "ENTRY admission cannot authorize another reservation kind");
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
