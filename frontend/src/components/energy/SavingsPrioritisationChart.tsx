import { useMemo } from "react";
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  ReferenceArea,
} from "recharts";
import type { DataQuality, EnergyOpportunity } from "@/types/api";
import {
  QUICK_WIN_PAYBACK_YEARS,
  toSavingsBubbles,
  type SavingsBubble,
} from "./savings-prioritisation-utils";

const QUALITY_COLOR: Record<DataQuality, string> = {
  observed: "hsl(142, 71%, 35%)",
  partial: "hsl(38, 92%, 50%)",
  assumed: "hsl(220, 9%, 60%)",
};

const QUALITY_LABEL: Record<DataQuality, string> = {
  observed: "Observed",
  partial: "Partial",
  assumed: "Assumed",
};

function fmtCurrency(value: number): string {
  return `£${Math.round(value).toLocaleString()}`;
}

function fmtYears(value: number): string {
  if (value === 0) return "immediate";
  if (value < 0.1) return "< 0.1 yr";
  return `${value.toFixed(1)} yr`;
}

function BubbleTooltip({ active, payload }: { active?: boolean; payload?: { payload: SavingsBubble }[] }) {
  if (!active || !payload?.length) return null;
  const b = payload[0].payload;
  return (
    <div className="rounded-lg border border-border/60 bg-card p-3 text-xs shadow-lg">
      <p className="font-medium text-foreground">{b.name}</p>
      <p className="text-muted-foreground">{b.equipmentName}</p>
      <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
        <li>
          Savings:{" "}
          <span className="font-mono font-medium text-foreground">{fmtCurrency(b.savings)}/yr</span>
        </li>
        <li>
          Payback: <span className="font-mono text-foreground">{fmtYears(b.payback)}</span>
        </li>
        <li>
          Capex: <span className="font-mono text-foreground">{fmtCurrency(b.capex)}</span>
        </li>
        <li>
          Data quality:{" "}
          <span className="text-foreground">{QUALITY_LABEL[b.quality]}</span>
        </li>
      </ul>
    </div>
  );
}

interface SavingsPrioritisationChartProps {
  opportunities: EnergyOpportunity[];
  equipmentName: (id: string) => string;
  height?: number;
}

/**
 * Viz 2 — impact vs payback bubble chart. x = simple payback (yrs),
 * y = annual savings (£/yr), bubble size = capex, colour = data quality.
 * The top-left band (low payback) is framed as "quick wins".
 */
export function SavingsPrioritisationChart({
  opportunities,
  equipmentName,
  height = 380,
}: SavingsPrioritisationChartProps) {
  const bubbles = useMemo(
    () => toSavingsBubbles(opportunities, equipmentName),
    [opportunities, equipmentName],
  );

  const maxSavings = useMemo(
    () => Math.max(1, ...bubbles.map((b) => b.savings)),
    [bubbles],
  );

  if (bubbles.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-2xl border border-border/60 bg-card"
        style={{ height }}
      >
        <p className="text-sm text-muted-foreground">
          No enabled opportunities with computed savings yet. Enable opportunities on the
          Opportunities page to see them prioritised here.
        </p>
      </div>
    );
  }

  const qualities: DataQuality[] = ["observed", "partial", "assumed"];

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-5">
      <ResponsiveContainer width="100%" height={height}>
        <ScatterChart margin={{ top: 16, right: 24, bottom: 36, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(220 13% 90% / 0.5)" />
          {/* Quick-wins band: low payback, full savings height. */}
          <ReferenceArea
            x1={0}
            x2={QUICK_WIN_PAYBACK_YEARS}
            y1={0}
            y2={maxSavings * 1.05}
            fill="hsl(142, 71%, 35%)"
            fillOpacity={0.07}
            label={{
              value: "Quick wins",
              position: "insideTopLeft",
              fontSize: 11,
              fill: "hsl(142, 51%, 32%)",
            }}
          />
          <XAxis
            type="number"
            dataKey="payback"
            name="Payback"
            domain={[0, "dataMax"]}
            tick={{ fontSize: 12, fill: "hsl(220 8% 46%)" }}
            tickLine={false}
            axisLine={false}
            label={{
              value: "Simple payback (years)",
              position: "insideBottom",
              offset: -18,
              fontSize: 12,
              fill: "hsl(220 8% 46%)",
            }}
          />
          <YAxis
            type="number"
            dataKey="savings"
            name="Annual savings"
            domain={[0, "dataMax"]}
            tick={{ fontSize: 12, fill: "hsl(220 8% 46%)" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => fmtCurrency(v)}
            width={72}
          />
          <ZAxis type="number" dataKey="capex" range={[80, 620]} name="Capex" />
          <Tooltip cursor={{ strokeDasharray: "3 3" }} content={<BubbleTooltip />} />
          {qualities.map((q) => (
            <Scatter
              key={q}
              name={QUALITY_LABEL[q]}
              data={bubbles.filter((b) => b.quality === q)}
              fill={QUALITY_COLOR[q]}
              fillOpacity={0.7}
            >
              {bubbles
                .filter((b) => b.quality === q)
                .map((b) => (
                  <Cell key={b.id} fill={QUALITY_COLOR[q]} />
                ))}
            </Scatter>
          ))}
        </ScatterChart>
      </ResponsiveContainer>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        {qualities.map((q) => (
          <span key={q} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: QUALITY_COLOR[q] }}
            />
            {QUALITY_LABEL[q]}
          </span>
        ))}
        <span className="ml-auto">Bubble size ∝ capex</span>
      </div>
    </div>
  );
}
