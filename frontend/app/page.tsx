"use client";

import React from "react";
import Link from "next/link";

export default function HomePage(): JSX.Element {
  const sections = [
    {
      href: "/dashboard",
      label: "Dashboard",
      description: "Live signals, positions, and session control",
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
        </svg>
      ),
    },
    {
      href: "/performance",
      label: "Performance",
      description: "P&L, equity curve, and trade analytics",
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      ),
    },
    {
      href: "/backtest",
      label: "Backtest",
      description: "Historical strategy testing with Breeze data",
      icon: (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
      ),
    },
  ];

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center">
      <div className="mb-10 text-center">
        <h1
          className="mb-2 text-2xl font-bold tracking-tight"
          style={{ color: "rgba(255,255,255,0.95)" }}
        >
          AI Options Paper Trading
        </h1>
        <p
          className="text-sm"
          style={{ color: "rgba(255,255,255,0.5)" }}
        >
          Indian equity options · NSE/BSE · Paper mode
        </p>
      </div>

      <div className="grid w-full max-w-2xl grid-cols-1 gap-4 sm:grid-cols-3">
        {sections.map(({ href, label, description, icon }) => (
          <Link
            key={href}
            href={href}
            className="group flex flex-col items-center gap-3 rounded-xl border border-[#1e1e1e] px-6 py-6 transition-all duration-200 hover:border-[rgba(0,200,83,0.4)] hover:shadow-[0_0_20px_rgba(0,200,83,0.08)]"
            style={{
              background:
                "linear-gradient(180deg, rgba(17,17,17,0.9) 0%, rgba(10,10,10,0.95) 100%)",
            }}
          >
            <div
              className="flex h-12 w-12 items-center justify-center rounded-lg text-[#00C853] transition-colors group-hover:bg-[rgba(0,200,83,0.12)]"
              style={{
                background: "rgba(0,200,83,0.08)",
                border: "1px solid rgba(0,200,83,0.25)",
              }}
            >
              {icon}
            </div>
            <span
              className="text-sm font-semibold uppercase tracking-wider"
              style={{ color: "rgba(255,255,255,0.9)" }}
            >
              {label}
            </span>
            <p
              className="text-center text-xs leading-relaxed"
              style={{ color: "rgba(255,255,255,0.45)" }}
            >
              {description}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
