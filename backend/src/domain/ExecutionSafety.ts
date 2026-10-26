/** No flag, credential or environment variable can enable the legacy Delta path. */
export function rejectDeltaExecution(): never {
  throw new Error("DELTA_EXECUTION_DISABLED: broker-fill ledger and protected exits required");
}

/** Void signature keeps legacy code typechecked while the runtime boundary always throws. */
export function denyCryptoExecution(): void { rejectDeltaExecution(); }
