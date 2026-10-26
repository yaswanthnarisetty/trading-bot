import type { PaperDisplayAnalytics } from "../../lib/api";

const shell = "rounded-2xl border border-white/[0.07] bg-white/[0.025] p-4 text-white/80";
const tile = "metric-tile min-w-0";
const label = "ui-label text-[0.62rem]";

function Metric({ title, value, tone = "text-white/85", detail }: {
  title: string; value: string; tone?: string; detail?: string;
}) {
  return <div className={tile}>
    <div className={label}>{title}</div>
    <div className={`mt-1 break-words font-mono text-lg font-semibold ${tone}`}>{value}</div>
    {detail && <p className="mt-1 text-[0.65rem] text-white/35">{detail}</p>}
  </div>;
}

function Missing({ detail }: { detail: string }) {
  return <p className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-4 text-sm text-white/40">{detail}</p>;
}

export function PaperGreeksPanel({ analytics }: { analytics: PaperDisplayAnalytics | null }) {
  const option = analytics?.option;
  return <section className={shell} aria-label="Estimated Greeks">
    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
      <div><h2 className="ui-label">Est. Greeks (Black–Scholes)</h2>
        <p className="mt-1 text-[0.65rem] text-white/35">Model estimate from a qualified Kite option quote</p></div>
      <span className="font-mono text-[0.65rem] tracking-widest text-white/35">Δ · Γ · Θ · V</span>
    </div>
    {option ? <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric title="Δ Delta" value={option.delta.toFixed(3)} tone={option.delta >= 0 ? "text-[#00C853]" : "text-[#FF1744]"} detail="Directional exposure" />
        <Metric title="Θ Theta/day" value={option.thetaPerDay.toFixed(3)} tone="text-[#FFB300]" detail="Time decay" />
        <Metric title="Γ Gamma" value={option.gamma.toFixed(5)} detail="Delta sensitivity" />
        <Metric title="V Vega" value={option.vegaPerPercent.toFixed(3)} detail="IV sensitivity" />
      </div>
      <p className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.025] px-3 py-2 font-mono text-xs text-white/55">
        Representative {option.type} quote · Strike {(option.strikeMinor / 100).toLocaleString("en-IN")} · Expiry {option.expiry} · Not a proposed trade
      </p>
    </> : <Missing detail={analytics ? "No qualified option Greeks were available in the recorded evaluation." : "Awaiting the first qualified evaluation."} />}
  </section>;
}

export function PaperIVPanel({ analytics }: { analytics: PaperDisplayAnalytics | null }) {
  const option = analytics?.option;
  return <section className={shell} aria-label="Implied volatility and option chain">
    <div className="mb-3 flex items-center justify-between gap-2"><h2 className="ui-label">IV &amp; option chain</h2><span className="font-mono text-[0.65rem] text-white/35">QUALIFIED QUOTE</span></div>
    {option ? <div className="mb-3 rounded-lg border border-white/[0.06] bg-white/[0.025] px-3 py-3">
      <div className={label}>Representative implied volatility</div>
      <div className="mt-1 font-mono text-xl font-semibold text-[#00C853]">{(option.impliedVolatility * 100).toFixed(1)}%</div>
      <p className="mt-1 text-xs text-white/40">{option.type} · {(option.strikeMinor / 100).toLocaleString("en-IN")} · {option.expiry}</p>
    </div> : <div className="mb-3"><Missing detail={analytics ? "No qualified option IV in the recorded evaluation." : "Awaiting the first qualified evaluation."} /></div>}
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Metric title="IV Rank" value="—" detail="No qualified rank series" />
      <Metric title="IV Percentile" value="—" detail="No qualified history" />
      <Metric title="PCR" value="—" detail="Not in current read model" />
      <Metric title="Max Pain" value="—" detail="Not in current read model" />
    </div>
  </section>;
}

export function PaperSupportResistancePanel() {
  return <section className={shell} aria-label="Support and resistance">
    <h2 className="ui-label mb-3">Support &amp; resistance</h2>
    <div className="grid grid-cols-2 gap-2">
      <Metric title="Resistance" value="—" tone="text-[#FF4569]" />
      <Metric title="Support" value="—" tone="text-[#00C853]" />
    </div>
    <p className="mt-3 text-xs text-white/40">No qualified support or resistance levels in the current PAPER read model.</p>
  </section>;
}

export function PaperIndicatorsPanel({ analytics }: { analytics: PaperDisplayAnalytics | null }) {
  const values = analytics?.indicators;
  return <section className={shell} aria-label="Indicators">
    <div className="mb-3 flex items-center justify-between"><h2 className="ui-label">Indicators</h2><span className="font-mono text-[0.65rem] text-white/35">EMA / ATR / VOL</span></div>
    {values ? <>
      <div className="mb-3 rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
        <div className={label}>RSI(14)</div>
        <div className={`mt-1 font-mono text-3xl font-bold ${values.rsi < 30 ? "text-[#00C853]" : values.rsi > 70 ? "text-[#FF1744]" : "text-white/85"}`}>{values.rsi.toFixed(1)}</div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full rounded-full bg-[#FFB300]" style={{ width: `${Math.max(0, Math.min(100, values.rsi))}%` }} /></div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Metric title="EMA 20" value={values.ema20?.toFixed(1) ?? "—"} />
        <Metric title="EMA 50" value={values.ema50?.toFixed(1) ?? "—"} />
        <Metric title="ATR" value={values.atr?.toFixed(1) ?? "—"} />
        <Metric title="Volume ratio" value={`${values.volumeRatio.toFixed(2)}×`} />
        <Metric title="EMA alignment" value={values.emaAlignment.toUpperCase()} />
        <Metric title="Regime" value={values.regime.toUpperCase()} />
        {analytics?.directionalTrend && <>
          <Metric title="ADX(14)" value={analytics.directionalTrend.adx14.toFixed(1)} detail="Trend strength; direction is shown by +DI / −DI" />
          <Metric title="+DI / −DI" value={`${analytics.directionalTrend.plusDi14.toFixed(1)} / ${analytics.directionalTrend.minusDi14.toFixed(1)}`} detail="Directional movement from completed candles" />
        </>}
      </div>
    </> : <Missing detail="Awaiting the first qualified evaluation." />}
  </section>;
}
