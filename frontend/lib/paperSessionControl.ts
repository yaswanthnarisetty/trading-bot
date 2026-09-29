/** Identity checks shared by start, reload, polling and stop. No global discovery. */
export interface PaperSessionIdentity {
  sessionId: string; accountId?: string; executionMode?: string; status: string;
}
export function retainPaperSession<T extends PaperSessionIdentity>(session: T, accountId: string, sessionId?: string): T {
  if (!accountId || session.accountId !== accountId || session.executionMode !== "PAPER"
    || !session.sessionId || (sessionId !== undefined && session.sessionId !== sessionId))
    throw new Error("SESSION_IDENTITY_MISMATCH");
  return session;
}
export async function discoverPaperSession<T extends PaperSessionIdentity>(accountId: string,
  read: (accountId: string) => Promise<T | null>): Promise<T | null> {
  if (!accountId) throw new Error("EXPLICIT_PAPER_ACCOUNT_REQUIRED");
  const session = await read(accountId);
  return session === null ? null : retainPaperSession(session, accountId);
}
export async function pollPaperSession<T extends PaperSessionIdentity>(selected: PaperSessionIdentity,
  read: (sessionId: string) => Promise<T>): Promise<T> {
  if (!selected.accountId) throw new Error("EXPLICIT_PAPER_ACCOUNT_REQUIRED");
  return retainPaperSession(await read(selected.sessionId), selected.accountId, selected.sessionId);
}
export async function stopPaperSession<T>(selected: PaperSessionIdentity, stop: (sessionId: string) => Promise<T>): Promise<T> {
  retainPaperSession(selected, selected.accountId ?? "", selected.sessionId);
  return stop(selected.sessionId);
}
