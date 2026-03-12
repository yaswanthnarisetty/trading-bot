import { useEffect, useState } from "react";
import { useAppContext } from "../context/AppContext";

/**
 * Formats an elapsed duration in seconds into "HH:MM:SS".
 * This is used by session headers and timers across the dashboard.
 *
 * @param seconds - Total elapsed seconds.
 * @returns Formatted time string in 24-hour style.
 */
export function formatElapsed(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;

  const hh = h.toString().padStart(2, "0");
  const mm = m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");

  return `${hh}:${mm}:${ss}`;
}

/**
 * React hook that re-renders once per second and derives elapsed time from
 * the server-provided session start timestamp.
 *
 * @returns The formatted elapsed time string for convenience in UI components.
 */
export function useSessionTimer(): string {
  const {
    state: { session },
  } = useAppContext();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (session.status !== "RUNNING" || !session.startTime) {
      return undefined;
    }

    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  }, [session.startTime, session.status]);

  const startedAt = Date.parse(session.startTime ?? "");
  if (!Number.isFinite(startedAt)) {
    return formatElapsed(0);
  }

  return formatElapsed((now - startedAt) / 1000);
}
