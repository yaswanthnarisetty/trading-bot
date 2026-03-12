import React from "react";
import { useAppContext } from "../../context/AppContext";

/**
 * Renders a sticky banner at the top of the page when running in MOCK data mode.
 * This visually warns the user that all prices and signals are simulated, not live broker data.
 *
 * @returns A JSX element containing the mock data warning, or null when not in MOCK mode.
 */
export function MockDataBanner(): JSX.Element | null {
  const {
    state: {
      session: { dataMode },
    },
  } = useAppContext();

  if (dataMode !== "MOCK") {
    return null;
  }

  return (
    <div className="sticky top-0 z-40 w-full bg-[#FFB300]/90 text-black border-b border-[#1e1e1e]">
      <div className="mx-auto flex max-w-6xl items-center justify-center px-4 py-2 text-xs font-sans">
        <span className="mr-2">⚠</span>
        <span className="font-medium">
          MOCK DATA MODE — No Kite broker connected. Using simulated market
          data.
        </span>
      </div>
    </div>
  );
}

export default MockDataBanner;

