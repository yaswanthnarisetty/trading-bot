import { validateExecutionWrite } from "../db/executionWriteBoundary";
import { Schema, type SchemaDefinition } from "mongoose";
import { executionModeSchema, executionScopeSchema } from "@trading-bot/shared";

export const idField = () => ({ type: String, required: true, trim: true, minlength: 1, maxlength: 200, immutable: true } as const);
export const unitsField = (positive = false) => ({
  type: Number, required: true, min: positive ? 1 : 0, max: Number.MAX_SAFE_INTEGER,
  validate: { validator: Number.isSafeInteger, message: "Expected safe integer contract units" },
} as const);
export const moneyField = (signed = false) => ({
  type: Number, required: true, min: signed ? Number.MIN_SAFE_INTEGER : 0, max: Number.MAX_SAFE_INTEGER,
  validate: { validator: Number.isSafeInteger, message: "Expected safe integer INR paise" },
} as const);
export const ledgerFields = () => ({
  accountId: idField(),
  executionMode: { type: String, enum: executionModeSchema.options, required: true, immutable: true },
  schemaVersion: { type: Number, enum: [1], required: true, immutable: true },
  correlationId: idField(),
  createdAt: { type: Date, required: true, immutable: true },
});

/**
 * Application write boundary. Native collection writes bypass Mongoose middleware:
 * future production DB roles must deny updates/deletes on immutable collections.
 */
export function executionSchema(fields: SchemaDefinition, collection: string, immutable = false): Schema {
  const schema = new Schema({ ...ledgerFields(), ...fields,
    ...(immutable ? {} : { version: { ...unitsField(), default: 0 }, updatedAt: { type: Date, required: true } }),
  }, { collection, strict: "throw", versionKey: immutable ? false : "version",
    optimisticConcurrency: !immutable, autoIndex: false, autoCreate: false, bufferCommands: false });
  schema.pre("validate", function () {
    const scope = executionScopeSchema.safeParse({ accountId: this.get("accountId"), executionMode: this.get("executionMode") });
    if (!scope.success) this.invalidate("accountId", "Account ID must begin with executionMode + ':'");
  });
  schema.pre("save", async function () {
    if (immutable && !this.isNew) throw new Error("APPEND_ONLY: existing ledger records cannot be saved");
    await validateExecutionWrite(this);
  });
  const reject = () => { throw new Error("LEDGER_WRITE_FORBIDDEN: use validated create or versioned document save"); };
  // Query mutations cannot perform cross-field document validation or prove state-machine evidence.
  // Mutable documents use save() with explicit versionKey + optimisticConcurrency instead.
  schema.pre(["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace",
    "deleteOne", "deleteMany", "findOneAndDelete"], reject);
  schema.pre("deleteOne", { document: true, query: false }, reject);
  schema.pre("bulkWrite", reject);
  schema.pre("insertMany", reject); // insertMany bypasses document save middleware
  return schema;
}

export function identityIndexes(schema: Schema, id: string): void {
  schema.index({ [id]: 1 }, { unique: true });
  schema.index({ accountId: 1, executionMode: 1, createdAt: -1 });
}

/** Optional broker identity/claim can be attached once after insert, never replaced. */
export function writeOnceFields(schema: Schema, fields: readonly string[]): void {
  const snapshots = new WeakMap<object, Map<string, string | undefined>>();
  const capture = (doc: { get(path: string): unknown }) => snapshots.set(doc, new Map(fields.map(field => [field, JSON.stringify(doc.get(field))])));
  schema.post("init", capture);
  schema.post("save", capture);
  schema.pre("validate", function () {
    for (const field of fields) {
      const previous = snapshots.get(this)?.get(field);
      if (previous !== undefined && previous !== JSON.stringify(this.get(field))) this.invalidate(field, "Field may be attached once, never replaced");
    }
  });
}

export function monotonicFields(schema: Schema, fields: readonly string[]): void {
  const snapshots = new WeakMap<object, Map<string, unknown>>();
  const capture = (doc: { get(path: string): unknown }) => snapshots.set(doc, new Map(fields.map(field => [field, doc.get(field)])));
  schema.post("init", capture);
  schema.post("save", capture);
  schema.pre("validate", function () {
    for (const field of fields) {
      const previous = snapshots.get(this)?.get(field), next = this.get(field);
      if (typeof previous === "number" && typeof next === "number" && next < previous) this.invalidate(field, "OBSERVATION_REGRESSION");
    }
  });
}
