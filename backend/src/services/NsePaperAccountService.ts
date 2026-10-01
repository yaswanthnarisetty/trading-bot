import { readFile } from "node:fs/promises";
import type { Connection } from "mongoose";
import { z } from "zod";
import { identifierSchema } from "@trading-bot/shared";
import { executionModels } from "../db/executionModels";
import { assertExecutionIndexes } from "../db/executionIndexes";
import { checkTransactionCapability } from "../db/executionReadiness";
import { entryRiskPolicySchema } from "../domain/entryRisk";
import { tradingCalendarSchema } from "../domain/realizedRisk";
import { reconciliationConfigSchema } from "../domain/reconciliation";
import { NSE_PAPER_POLICY_V1 } from "../config/nsePaperPolicy";

export const NSE_PAPER_ACCOUNT_ID = "PAPER:NSE";
const scope = { accountId: NSE_PAPER_ACCOUNT_ID, executionMode: "PAPER" } as const;

const provisioningSchema = z.object({
  // Explicit, verified Kite account identity for reference-only reconciliation.
  brokerAccountId: identifierSchema,
  entryRiskPolicy: entryRiskPolicySchema.refine(policy => policy.maxDailyLossMinor !== undefined),
  riskTradingCalendar: tradingCalendarSchema,
}).strict();

/** Decimal rupees to integer paise. Never round a floating-point rupee value. */
export function paperCapitalMinor(value: string | undefined): number {
  if (!value || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) throw new Error("PAPER_CAPITAL_REQUIRED");
  const [rupees, fraction = ""] = value.split(".");
  const paise = BigInt(rupees) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (paise <= 0n || paise > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("PAPER_CAPITAL_INVALID");
  return Number(paise);
}

function assertCanonical(accounts: readonly Record<string, any>[], capitalMinor: number) {
  if (accounts.length > 1) throw new Error("PAPER_ACCOUNT_AMBIGUOUS");
  const account = accounts[0];
  if (!account) return null;
  if (account.accountId !== NSE_PAPER_ACCOUNT_ID || account.executionMode !== "PAPER"
    || account.broker !== "PAPER" || account.currency !== "INR") throw new Error("PAPER_ACCOUNT_CONFLICT");
  // Older manually provisioned accounts predate this reference field. Reuse
  // them unchanged; only a persisted, conflicting capital assertion is fatal.
  if (account.initialCapitalMinor !== undefined && account.initialCapitalMinor !== capitalMinor)
    throw new Error("PAPER_ACCOUNT_CAPITAL_CONFLICT");
  return account;
}

/** Startup-only create-if-missing. Existing financial state is never saved or repaired. */
export async function ensureNsePaperAccount(connection: Connection, env: NodeJS.ProcessEnv = process.env,
  readProvisioning: (path: string) => Promise<string> = path => readFile(path, "utf8")): Promise<void> {
  const capitalMinor = paperCapitalMinor(env.PAPER_CAPITAL);
  if (capitalMinor !== NSE_PAPER_POLICY_V1.initialCapitalMinor) throw new Error("PAPER_CAPITAL_POLICY_V1_MISMATCH");
  if (connection.readyState !== 1) throw new Error("PERSISTENCE_NOT_READY");
  const models = executionModels(connection);
  const findCanonical = () => models.TradingAccount.find({ accountId: NSE_PAPER_ACCOUNT_ID }).limit(2).lean<Record<string, any>[]>();
  const first = assertCanonical(await findCanonical(), capitalMinor);
  await assertExecutionIndexes(connection, "ALL");
  if (!(await checkTransactionCapability(connection)).supported) throw new Error("PERSISTENCE_NOT_READY");
  if (first) return;

  const path = env.NSE_PAPER_ACCOUNT_CONFIG_FILE;
  let parsed: z.infer<typeof provisioningSchema> | undefined;
  if (path) {
    try { parsed = provisioningSchema.parse(JSON.parse(await readProvisioning(path))); }
    catch { throw new Error("PAPER_ACCOUNT_POLICY_INVALID"); }
  }
  const configured = parsed ?? NSE_PAPER_POLICY_V1;
  const policy = entryRiskPolicySchema.parse(configured.entryRiskPolicy);
  if (policy.maxReservedRiskMinor > capitalMinor || policy.maxRiskPerEntryMinor > policy.maxReservedRiskMinor
    || policy.maxDailyLossMinor! > capitalMinor) throw new Error("PAPER_ACCOUNT_POLICY_INVALID");

  const now = new Date();
  const account = {
    ...scope, schemaVersion: 1, correlationId: "NSE_PAPER_ACCOUNT_BOOTSTRAP_V1", createdAt: now, updatedAt: now,
    broker: "PAPER", brokerAccountRef: NSE_PAPER_ACCOUNT_ID, currency: "INR", initialCapitalMinor: capitalMinor,
    admissionStatus: "PAPER_READY", policyVersion: policy.policyVersion, executionEpoch: 1,
    entryRiskPolicy: policy, riskTradingCalendar: configured.riskTradingCalendar,
    ...(parsed ? { reconciliationConfig: reconciliationConfigSchema.parse({
      kind: "PAPER_KITE_SHADOW_V1", scope: "REFERENCE_ONLY", brokerAccountId: parsed.brokerAccountId,
    }) } : {}),
    reservedMarginMinor: 0, reservedExposureMinor: 0, committedExposureMinor: 0, realizedPnlMinor: 0,
    positionSlots: 0, committedPositionSlots: 0, nextEventSequence: 1,
  };
  await new models.TradingAccount(account).validate();
  const session = await connection.startSession();
  try {
    try {
      await session.withTransaction(async () => {
        if (assertCanonical(await models.TradingAccount.find({ accountId: NSE_PAPER_ACCOUNT_ID }).limit(2).session(session).lean<Record<string, any>[]>(), capitalMinor)) return;
        await new models.TradingAccount(account).save({ session });
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } catch (error) {
      // A second host may win the unique accountId race. Return only its exact
      // canonical, capital-matched record; all other failures remain fatal.
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === 11000)) throw error;
    }
  } finally { await session.endSession(); }
  if (!assertCanonical(await findCanonical(), capitalMinor)) throw new Error("PAPER_ACCOUNT_REQUIRED");
}

/** First verified Kite session binds the reference-only comparison identity once.
 * Caller must supply the account ID from a profile-verified KiteReadSession.
 * No reconciliation or recovery proof is created here. */
export async function bindNsePaperKiteIdentity(connection: Connection, verifiedBrokerAccountId: string): Promise<void> {
  const brokerAccountId = identifierSchema.parse(verifiedBrokerAccountId);
  await assertExecutionIndexes(connection, "ALL");
  if (!(await checkTransactionCapability(connection)).supported) throw new Error("PERSISTENCE_NOT_READY");
  const models = executionModels(connection), session = await connection.startSession();
  try {
    await session.withTransaction(async () => {
      const account = await models.TradingAccount.findOne(scope).session(session).orFail();
      const existing = account.get("reconciliationConfig");
      if (existing !== undefined) {
        if (reconciliationConfigSchema.parse(existing).brokerAccountId !== brokerAccountId)
          throw new Error("PAPER_KITE_ACCOUNT_CONFLICT");
        return;
      }
      if (account.get("recoveryState") !== undefined || account.get("reconciliationState") !== undefined)
        throw new Error("PAPER_KITE_ACCOUNT_CONFLICT");
      account.set("reconciliationConfig", reconciliationConfigSchema.parse({
        kind: "PAPER_KITE_SHADOW_V1", scope: "REFERENCE_ONLY", brokerAccountId,
      }));
      await account.save({ session });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } finally { await session.endSession(); }
}
