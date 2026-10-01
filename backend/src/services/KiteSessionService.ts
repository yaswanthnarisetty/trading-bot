import { createHash, randomBytes } from "node:crypto";
import type { AxiosInstance } from "axios";
import { fail, istDate, responseData, safeMarketError } from "../domain/kiteMarketData";

export type MarketDataMode = "MOCK" | "KITE_REAL";
export interface KiteMarketSession { get(path: string, params?: URLSearchParams): Promise<unknown> }
/** Single-operator backend session. Credentials stay in memory; restart requires login.
 * Only POST /session/token and allowlisted GETs exist. No order-write capability. */
export class KiteSessionService implements KiteMarketSession {
  private session: { token: string; account: string; expiresAt: number; generation: number } | null = null;
  private generation = 0;
  private boundAccount: string | null = null;
  private login: { state: string; expiresAt: number } | null = null;
  private mode: MarketDataMode;
  private queues = new Map<string, Promise<void>>();
  private next = new Map<string, number>();
  constructor(private readonly client: Pick<AxiosInstance, "get" | "post">,
    private readonly config: () => { apiKey: string; apiSecret: string; expectedAccountId?: string },
    private readonly clock: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    mode: MarketDataMode = "KITE_REAL", private readonly allowMockFixtures = false) {
    if (mode === "MOCK" && !allowMockFixtures) fail("DATA_MODE_REQUIRED");
    this.mode = mode;
  }
  getMode(): MarketDataMode { return this.mode; }
  setMode(mode: unknown): void {
    if (mode !== "MOCK" && mode !== "KITE_REAL") fail("INVALID_REQUEST");
    if (mode === "MOCK" && !this.allowMockFixtures) fail("DATA_MODE_REQUIRED");
    this.mode = mode as MarketDataMode;
  }
  private current() {
    if (!this.session || this.clock() >= this.session.expiresAt) { this.session = null; return fail("SESSION_REQUIRED"); }
    return this.session;
  }
  private headers(token: string) { return { "X-Kite-Version": "3", Authorization: `token ${this.config().apiKey}:${token}` }; }
  getAuthHeader(): Record<string, string> { return this.headers(this.current().token); }
  status() {
    if (this.session && this.clock() >= this.session.expiresAt) this.session = null;
    return Object.freeze({ connectionStatus: this.session ? "CONNECTED" as const : this.config().apiKey ? "SESSION_REQUIRED" as const : "DISCONNECTED" as const,
      tokenValid: !!this.session, brokerAccountId: this.session?.account ?? null,
      tokenExpiry: this.session ? new Date(this.session.expiresAt).toISOString() : "—", dataMode: this.mode,
      tradingPhase: "PAPER" as const, execution: "PaperBroker" as const });
  }
  beginLogin(): string {
    const key = this.config().apiKey;
    if (!key) return fail("SESSION_REQUIRED");
    const state = randomBytes(32).toString("hex");
    this.login = { state, expiresAt: this.clock() + 600000 };
    const url = new URL("https://kite.zerodha.com/connect/login");
    url.search = new URLSearchParams({ v: "3", api_key: key, redirect_params: new URLSearchParams({ state }).toString() }).toString();
    return url.toString();
  }
  async callback(query: Record<string, unknown>): Promise<void> {
    const login = this.login;
    if (!login || login.expiresAt <= this.clock() || query.state !== login.state) return fail("INVALID_REQUEST");
    this.login = null; // one use, including failure; tokens never stored in callback state.
    this.session = null;
    ++this.generation;
    if (query.status !== "success") return fail("AUTHENTICATION_FAILED");
    await this.exchange(query.request_token);
  }
  async exchange(requestToken: unknown): Promise<void> {
    const pendingLogin = this.login;
    this.session = null;
    const generation = ++this.generation;
    if (typeof requestToken !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(requestToken)) return fail("INVALID_REQUEST");
    const { apiKey, apiSecret, expectedAccountId } = this.config();
    if (!apiKey || !apiSecret) return fail("SESSION_REQUIRED");
    try {
      const checksum = createHash("sha256").update(apiKey + requestToken + apiSecret).digest("hex");
      const data = responseData((await this.client.post("/session/token", new URLSearchParams({ api_key: apiKey, request_token: requestToken, checksum }).toString(),
        { headers: { "X-Kite-Version": "3", "Content-Type": "application/x-www-form-urlencoded" } })).data);
      if (typeof data.access_token !== "string" || !/^[^:\s]{1,512}$/.test(data.access_token)
        || typeof data.user_id !== "string" || !/^[A-Za-z0-9]{1,32}$/.test(data.user_id) || data.api_key !== apiKey) return fail();
      const profile = responseData((await this.client.get("/user/profile", { headers: this.headers(data.access_token) })).data);
      if (profile.user_id !== data.user_id || profile.broker !== "ZERODHA" || (expectedAccountId && profile.user_id !== expectedAccountId)
        || (this.boundAccount && profile.user_id !== this.boundAccount)) return fail("AUTHENTICATION_FAILED");
      if (generation !== this.generation) return fail("AUTHENTICATION_FAILED");
      const nextDay = new Date(`${istDate(this.clock())}T00:30:00Z`).getTime() + 86400000;
      this.session = { token: data.access_token, account: data.user_id, expiresAt: nextDay, generation };
      this.boundAccount = data.user_id;
      if (pendingLogin && this.login === pendingLogin) this.login = null;
    } catch (error) { throw safeMarketError(error); }
  }
  async validate(): Promise<boolean> {
    const generation = this.generation;
    try {
      const s = this.current(), profile = responseData(await this.get("/user/profile"));
      if (profile.user_id !== s.account || profile.broker !== "ZERODHA") fail("AUTHENTICATION_FAILED");
      return true;
    } catch { if (generation === this.generation) this.session = null; return false; }
  }
  async get(path: string, params?: URLSearchParams): Promise<unknown> {
    if (!["/instruments", "/quote", "/quote/ltp", "/quote/ohlc", "/user/profile"].includes(path)
      && !/^\/instruments\/historical\/[1-9]\d{0,29}\/(minute|3minute|5minute|10minute|15minute|30minute|60minute|day)$/.test(path)) return fail("INVALID_REQUEST");
    const s = this.current();
    const group = path.startsWith("/quote") ? "quote" : path.startsWith("/instruments/historical/") ? "history" : "other";
    // Serialize request starts per endpoint family. No retry; cross-process throttling is deferred.
    const gap = group === "quote" ? 1000 : group === "history" ? 350 : 100;
    const ticket = (this.queues.get(group) ?? Promise.resolve()).then(async () => {
      const delay = Math.max(0, (this.next.get(group) ?? 0) - this.clock());
      if (delay) await this.sleep(delay);
      this.next.set(group, this.clock() + gap);
    });
    this.queues.set(group, ticket.catch(() => undefined));
    await ticket;
    if (this.current() !== s) return fail("SESSION_REQUIRED");
    try {
      const result = (await this.client.get(path, { headers: this.headers(s.token), params,
        ...(path === "/instruments" ? { responseType: "text" as const, transformResponse: [(data: unknown) => data] } : {}) })).data as unknown;
      if (this.current() !== s) return fail("SESSION_REQUIRED");
      if (path !== "/instruments") responseData(result);
      else if (typeof result !== "string") return fail();
      return result;
    } catch (error) {
      const safe = safeMarketError(error);
      if (safe.code === "AUTHENTICATION_FAILED" && this.session === s) this.session = null;
      throw safe;
    }
  }
}
