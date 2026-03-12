"use client";

import React, { type ReactNode } from "react";
import "./globals.css";
import { AppProvider } from "../context/AppContext";

interface RootLayoutProps {
  children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#0a0a0a] text-[#f0f0f0]">
        <AppProvider>{children}</AppProvider>
      </body>
    </html>
  );
}
