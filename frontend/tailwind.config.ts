import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./context/**/*.{js,ts,jsx,tsx}",
    "./hooks/**/*.{js,ts,jsx,tsx}",
    "./lib/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        buy: "#00C853",
        sell: "#FF1744",
        hold: "#FFB300",
        blocked: "#546E7A",
        surface: "#111111",
        "surface-2": "#161616",
        border: "#1e1e1e",
      },
      fontFamily: {
        data: ["'JetBrains Mono'", "monospace"],
        ui: ["'Geist Sans'", "system-ui", "sans-serif"],
      },
      boxShadow: {
        "glow-buy": "0 0 16px rgba(0, 200, 83, 0.4)",
        "glow-sell": "0 0 16px rgba(255, 23, 68, 0.4)",
        "glow-hold": "0 0 16px rgba(255, 179, 0, 0.4)",
        "card": "0 4px 24px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255,255,255,0.04)",
      },
      backgroundImage: {
        "gradient-card": "linear-gradient(135deg, #161616 0%, #0e0e0e 100%)",
        "gradient-buy": "linear-gradient(90deg, #00C853, #00e676)",
        "gradient-sell": "linear-gradient(90deg, #FF1744, #ff4569)",
        "gradient-hold": "linear-gradient(90deg, #FFB300, #ffc107)",
        "gradient-iv": "linear-gradient(90deg, #00C853 0%, #FFB300 50%, #FF1744 100%)",
      },
      keyframes: {
        "pulse-signal": {
          "0%": { opacity: "0.5", transform: "scale(0.99)" },
          "50%": { opacity: "1", transform: "scale(1.01)" },
          "100%": { opacity: "0.5", transform: "scale(0.99)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% center" },
          "100%": { backgroundPosition: "200% center" },
        },
        "slide-in": {
          "0%": { opacity: "0", transform: "translateY(-8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "status-pulse": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.5", transform: "scale(1.5)" },
        },
      },
      animation: {
        "pulse-signal": "pulse-signal 1.4s ease-in-out infinite",
        shimmer: "shimmer 1.6s ease infinite",
        "slide-in": "slide-in 0.28s ease forwards",
        "fade-in": "fade-in 0.4s ease forwards",
        "status-pulse": "status-pulse 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
