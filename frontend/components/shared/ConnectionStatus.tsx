import React from "react";
import { useAppContext } from "../../context/AppContext";

interface ConnectionStatusProps {
  onReconnect?: () => void;
}

/**
 * Displays a compact badge representing the current WebSocket connection state.
 * This helps users quickly understand whether the dashboard is receiving live updates.
 *
 * @param props - Optional reconnect callback invoked when the user presses Reconnect.
 * @returns A JSX element showing the connection status badge.
 */
export function ConnectionStatus({
  onReconnect,
}: ConnectionStatusProps): JSX.Element {
  const {
    state: {
      ws: { status, retryCount },
    },
  } = useAppContext();

  let label = "";
  let color = "";
  let pulse = false;

  if (status === "CONNECTED") {
    label = "LIVE";
    color = "#00C853";
  } else if (status === "CONNECTING") {
    label = "CONNECTING...";
    color = "#FFB300";
  } else if (status === "RECONNECTING") {
    label = `RECONNECTING (attempt ${retryCount || 1})...`;
    color = "#FFB300";
    pulse = true;
  } else {
    label = "DISCONNECTED";
    color = "#FF1744";
  }

  return (
    <div className="pointer-events-auto fixed right-4 top-4 z-30 flex items-center gap-2 rounded-full border border-[#1e1e1e] bg-[#111111] px-3 py-1.5 text-xs font-sans text-[#e0e0e0] shadow-lg">
      <span
        className={[
          "h-2.5 w-2.5 rounded-full",
          pulse ? "animate-pulse-signal" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ backgroundColor: color }}
      />
      <span className="uppercase tracking-wide text-[0.7rem]">{label}</span>
      {status === "DISCONNECTED" && onReconnect && (
        <button
          type="button"
          onClick={onReconnect}
          className="ml-2 rounded-full border border-[#1e1e1e] bg-transparent px-2 py-0.5 text-[0.7rem] font-medium text-[#FFB300] hover:border-[#FFB300]"
        >
          Reconnect
        </button>
      )}
    </div>
  );
}

export default ConnectionStatus;

