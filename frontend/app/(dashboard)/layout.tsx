"use client";

import React, { type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { deleteCookie } from "cookies-next";

interface DashboardLayoutProps {
  children: ReactNode;
}

function NavBar(): JSX.Element {
  const pathname = usePathname();

  const links = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/performance", label: "Performance" },
    { href: "/backtest", label: "Backtest" },
    { href: "/settings", label: "Settings" },
  ];

  const logout = () => {
    deleteCookie("token");
    // Redirect to auth route
    window.location.href = "/login";
  };

  return (
    <header
      className="sticky top-0 z-50 border-b border-[#1e1e1e]"
      style={{
        background:
          "linear-gradient(180deg, rgba(13,13,13,0.97) 0%, rgba(10,10,10,0.95) 100%)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
      }}
    >
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        {/* Brand */}
        <div className="flex items-center gap-2.5">
          {/* Bot icon */}
          <div
            className="flex h-7 w-7 items-center justify-center rounded-lg"
            style={{
              background:
                "linear-gradient(135deg, rgba(0,200,83,0.25) 0%, rgba(0,200,83,0.08) 100%)",
              border: "1px solid rgba(0,200,83,0.35)",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#00C853"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="11" width="18" height="10" rx="2" />
              <path d="M12 11V7" />
              <circle cx="12" cy="5" r="2" />
              <path d="M7 15h.01M12 15h.01M17 15h.01" />
            </svg>
          </div>
          <div className="flex flex-col">
            <span
              className="text-[0.65rem] font-bold tracking-[0.22em] uppercase"
              style={{ color: "rgba(255,255,255,0.85)" }}
            >
              AI Options Bot
            </span>
            <span
              className="text-[0.55rem] tracking-widest uppercase"
              style={{ color: "rgba(0,200,83,0.7)" }}
            >
              Paper Trading
            </span>
          </div>
        </div>

        {/* Nav links */}
        <div className="flex items-center gap-1">
          {links.map(({ href, label }) => {
            const isActive = pathname === href || pathname.startsWith(href + "/");
            return (
              <Link
                key={href}
                href={href}
                className="relative px-4 py-1.5 text-[0.72rem] font-semibold uppercase tracking-widest transition-all duration-200"
                style={{
                  color: isActive ? "#00C853" : "rgba(255,255,255,0.5)",
                }}
              >
                {label}
                {isActive && (
                  <span
                    className="absolute bottom-0 left-1/2 h-[2px] w-4/5 -translate-x-1/2 rounded-full"
                    style={{
                      background: "linear-gradient(90deg, #00C853, #00e676)",
                      boxShadow: "0 0 8px rgba(0,200,83,0.7)",
                    }}
                  />
                )}
              </Link>
            );
          })}

          <button onClick={logout} className="px-3 py-2 bg-red-500 text-white rounded">
            Logout
          </button>
        </div>
      </nav>
    </header>
  );
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  return (
    <div>
      <NavBar />
      <main className="mx-auto max-w-6xl px-4 py-5">{children}</main>
    </div>
  );
}
