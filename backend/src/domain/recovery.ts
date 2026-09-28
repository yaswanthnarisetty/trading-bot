import { z } from "zod";
import { identifierSchema, quantityUnitsSchema } from "@trading-bot/shared";
import { fingerprint } from "./reconciliation";

const common = {
  generation: quantityUnitsSchema.refine(n => n > 0), commandKey: identifierSchema,
  // Old unbound history remains readable, but is never ENTRY authority.
  startupId: identifierSchema.optional(),
  beginEventId: identifierSchema, requiredAt: z.string().datetime(),
};
export const recoveryStateSchema = z.discriminatedUnion("status", [
  z.object({ ...common, status: z.literal("RECOVERY_REQUIRED") }).strict(),
  z.object({ ...common, status: z.literal("READY"), recordId: identifierSchema,
    readyEventId: identifierSchema, readyAt: z.string().datetime() }).strict(),
]);
export type RecoveryState = z.infer<typeof recoveryStateSchema>;
export const recoveryBeginId = (accountId: string, commandKey: string, startupId: string) => `recovery-begin:${fingerprint([accountId, startupId, commandKey])}`;
export const recoveryReadyId = (accountId: string, generation: number) => `recovery-ready:${fingerprint([accountId, generation])}`;
