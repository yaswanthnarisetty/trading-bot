import React from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Label,
} from "recharts";
import type { PerformanceData } from "../../lib/api";

interface WinRateChartProps {
  data: PerformanceData["rollingWinRate"];
}

export function WinRateChart({ data }: WinRateChartProps): JSX.Element {
  const lastRate = data.length
    ? data[data.length - 1]?.winRate ?? 0
    : 0;
  const lineColor =
    lastRate >= 55
      ? "#00C853"
      : lastRate >= 50
        ? "#FFB300"
        : "#FF1744";

  return (
    <div
      className="rounded-2xl p-4"
      style={{
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="ui-label">Rolling Win Rate</span>
        <div className="flex items-center gap-3">
          <span
            className="font-mono text-[0.68rem]"
            style={{ color: "rgba(255,255,255,0.35)" }}
          >
            20-signal window
          </span>
          {lastRate > 0 && (
            <span
              className="font-mono text-sm font-bold"
              style={{ color: lineColor }}
            >
              {lastRate.toFixed(1)}%
            </span>
          )}
        </div>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid
              stroke="rgba(255,255,255,0.04)"
              strokeDasharray="3 3"
              vertical={false}
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
              domain={[0, 100]}
              tickFormatter={(v) => `${v as number}%`}
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
              itemStyle={{ color: lineColor }}
              labelStyle={{ color: "rgba(255,255,255,0.5)", marginBottom: 4 }}
              formatter={(value) => [
                `${(value as number).toFixed(1)}%`,
                "Win Rate",
              ]}
              labelFormatter={(label) => `Signal #${(label as number) + 1}`}
            />
            {/* Breakeven line */}
            <ReferenceLine
              y={50}
              stroke="rgba(84,110,122,0.6)"
              strokeDasharray="5 4"
              label={
                <Label
                  value="Breakeven"
                  position="insideTopLeft"
                  style={{ fontSize: 9, fill: "rgba(84,110,122,0.8)", fontFamily: "JetBrains Mono" }}
                />
              }
            />
            {/* Target line */}
            <ReferenceLine
              y={55}
              stroke="rgba(0,200,83,0.5)"
              strokeDasharray="5 4"
              label={
                <Label
                  value="Target"
                  position="insideTopLeft"
                  style={{ fontSize: 9, fill: "rgba(0,200,83,0.8)", fontFamily: "JetBrains Mono" }}
                />
              }
            />
            <Line
              type="monotone"
              dataKey="winRate"
              stroke={lineColor}
              strokeWidth={2}
              dot={false}
              activeDot={{
                r: 5,
                fill: lineColor,
                stroke: "rgba(255,255,255,0.3)",
                strokeWidth: 2,
              }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default WinRateChart;
