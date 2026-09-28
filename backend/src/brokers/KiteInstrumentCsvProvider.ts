import type { AxiosInstance } from "axios";
import { BrokerReadError, classifyKiteReadError } from "./KiteReadOnlyAdapter";

/** Trusted bootstrap dependency. Fixtures implement this interface offline.
 * This market-wide dump is not account/order evidence and has no execution capability. */
export interface KiteInstrumentCsvProvider { getInstrumentsCsv(): Promise<string> }

export function createKiteInstrumentCsvProvider(client: Pick<AxiosInstance, "get">,
  headers: () => Record<string, string>): KiteInstrumentCsvProvider {
  const captured: Record<string, string> = { ...headers(), "X-Kite-Version": "3" };
  if (!/^token [^:\s]+:[^:\s]+$/.test(captured.Authorization ?? "")) throw new BrokerReadError("AUTHENTICATION_FAILED");
  return Object.freeze({ async getInstrumentsCsv() {
    try {
      const result = await client.get("/instruments", { headers: { ...captured }, responseType: "text",
        transformResponse: [(data: unknown) => data] });
      if (typeof result.data !== "string") throw new BrokerReadError("INVALID_RESPONSE");
      return result.data;
    } catch (error) {
      const safe = classifyKiteReadError(error); throw new BrokerReadError(safe.code, safe.httpStatus);
    }
  } });
}
