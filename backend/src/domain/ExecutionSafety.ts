/** No flag, credential or environment variable can enable Delta in Phase 2A. */
export function rejectDeltaExecution(): never {
  throw new Error("DELTA_EXECUTION_DISABLED: NSE execution foundation only");
}

/** Void signature keeps legacy code typechecked while the runtime boundary always throws. */
export function denyCryptoExecution(): void { rejectDeltaExecution(); }
