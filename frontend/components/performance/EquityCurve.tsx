import React from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceLine,
} from "recharts";
import type { PerformanceData } from "../../lib/api";

interface EquityCurveProps {
  data: PerformanceData["equityCurve"];
}

export function EquityCurve({ data }: EquityCurveProps): JSX.Element {
  const lastPnl = data.length ? data[data.length - 1]!.pnl : 0;
  const isPositive = lastPnl >= 0;
  const fillColor = isPositive ? "#00C853" : "#FF1744";
  const fillColorDim = isPositive
    ? "rgba(0,200,83,0.15)"
    : "rgba(255,23,68,0.15)";

  const chartData = data.map((point, index) => ({
    ...point,
    index,
  }));

  const maxPnl = Math.max(...data.map((d) => d.pnl), 0);
  const minPnl = Math.min(...data.map((d) => d.pnl), 0);

  return (
    <div
      className="rounded-2xl p-4"
      style={{
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="ui-label">Equity Curve</span>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[0.68rem]" style={{ color: "rgba(255,255,255,0.35)" }}>
            {chartData.length} trades
          </span>
          <span
            className="font-mono text-sm font-bold"
            style={{ color: fillColor }}
          >
            {lastPnl >= 0 ? "+" : ""}₹{lastPnl.toFixed(2)}
          </span>
        </div>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={chartData}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <defs>
              <linearGradient
                id="equityGradient"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="0%"
                  stopColor={fillColor}
                  stopOpacity={0.5}
                />
                <stop
                  offset="100%"
                  stopColor={fillColor}
                  stopOpacity={0.02}
                />
              </linearGradient>
            </defs>
            <CartesianGrid
              stroke="rgba(255,255,255,0.04)"
              strokeDasharray="3 3"
              vertical={false}
            />
            <ReferenceLine
              y={0}
              stroke="rgba(255,255,255,0.15)"
              strokeDasharray="4 4"
            />
            <XAxis
              dataKey="index"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 9, fill: "rgba(255,255,255,0.3)", fontFamily: "JetBrains Mono" }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 9, fill: "rgba(255,255,255,0.3)", fontFamily: "JetBrains Mono" }}
              tickFormatter={(v) => `₹${(v as number).toFixed(0)}`}
              domain={[minPnl * 1.1 - 10, maxPnl * 1.1 + 10]}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "rgba(14,14,14,0.95)",
                borderColor: "rgba(255,255,255,0.1)",
                borderRadius: 10,
                fontSize: 12,
                fontFamily: "JetBrains Mono",
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
              }}
              itemStyle={{ color: fillColor }}
              labelStyle={{ color: "rgba(255,255,255,0.5)", marginBottom: 4 }}
              formatter={(value) => [
                `₹${(value as number).toFixed(2)}`,
                "PnL",
              ]}
              labelFormatter={(label) => `Trade #${(label as number) + 1}`}
            />
            <Area
              type="monotone"
              dataKey="pnl"
              stroke={fillColor}
              strokeWidth={2}
              fill="url(#equityGradient)"
              dot={false}
              activeDot={{
                r: 5,
                fill: fillColor,
                stroke: "rgba(255,255,255,0.3)",
                strokeWidth: 2,
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default EquityCurve;
