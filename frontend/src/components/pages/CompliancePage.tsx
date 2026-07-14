import { useMemo, useState } from "react";
import { ShieldCheck, Thermometer, Gauge } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSiteContext } from "@/contexts/site-context";
import {
  useComplianceEquipmentAnalytics,
  useComplianceSummary,
} from "@/hooks/use-compliance";
import type { ComplianceDial } from "@/types/api";
import { cn, severityVariant } from "@/lib/utils";

type Period = "7d" | "30d";

function periodWindow(p: Period): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (p === "7d" ? 7 : 30));
  return { start: start.toISOString(), end: end.toISOString() };
}

function PeriodToggle({ value, onChange }: { value: Period; onChange: (v: Period) => void }) {
  const options: Period[] = ["7d", "30d"];
  return (
    <div className="inline-flex h-9 items-center gap-1 rounded-lg bg-muted/70 p-1">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={value === o}
          onClick={() => onChange(o)}
          className={cn(
            "inline-flex items-center justify-center rounded-md px-3 py-1 text-xs font-medium transition-all",
            value === o
              ? "bg-card text-foreground shadow-sm shadow-black/[0.04]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function DialCard({ dial }: { dial: ComplianceDial }) {
  // SVG arc dial: 240° sweep, filled proportionally to active_count / evaluated_count.
  const total = Math.max(dial.evaluated_count, dial.active_count, 1);
  const ratio = Math.min(1, dial.active_count / total);
  const radius = 42;
  const cx = 56;
  const cy = 56;
  const startAngle = 150;       // degrees, SVG coords
  const sweep = 240;
  const endAngle = startAngle + sweep * ratio;

  const polar = (angle: number) => {
    const a = ((angle - 90) * Math.PI) / 180;
    return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)] as const;
  };
  const [bx, by] = polar(startAngle);
  const [fxEnd, fyEnd] = polar(startAngle + sweep);
  const [tx, ty] = polar(endAngle);
  const largeArc = sweep * ratio > 180 ? 1 : 0;

  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-medium leading-tight">{dial.name}</CardTitle>
        <p className="font-mono text-[10px] text-muted-foreground">{dial.fault_id}</p>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-1 pt-2">
        <svg width={112} height={88} role="img" aria-label={`${dial.name} dial`}>
          <path
            d={`M ${bx} ${by} A ${radius} ${radius} 0 1 1 ${fxEnd} ${fyEnd}`}
            className="fill-none stroke-muted"
            strokeWidth={8}
            strokeLinecap="round"
          />
          {ratio > 0 && (
            <path
              d={`M ${bx} ${by} A ${radius} ${radius} 0 ${largeArc} 1 ${tx} ${ty}`}
              className={cn(
                "fill-none",
                dial.active_count === 0
                  ? "stroke-success"
                  : "stroke-destructive",
              )}
              strokeWidth={8}
              strokeLinecap="round"
            />
          )}
          <text
            x={cx}
            y={cy + 4}
            textAnchor="middle"
            className="fill-foreground text-xl font-semibold tabular-nums"
          >
            {dial.active_count}
          </text>
        </svg>
        <p className="text-[11px] text-muted-foreground">
          of {dial.evaluated_count} evaluated
        </p>
        <Badge variant={severityVariant(dial.severity)} className="mt-1">
          {dial.severity}
        </Badge>
      </CardContent>
    </Card>
  );
}

function formatNumber(v: number | null, digits = 1, unit = ""): string {
  if (v == null || Number.isNaN(v)) return "-";
  return `${v.toFixed(digits)}${unit}`;
}

export function CompliancePage() {
  const { selectedSiteId } = useSiteContext();
  const [period, setPeriod] = useState<Period>("7d");
  const { start, end } = useMemo(() => periodWindow(period), [period]);

  const summaryQuery = useComplianceSummary(selectedSiteId);
  const analyticsQuery = useComplianceEquipmentAnalytics(
    selectedSiteId,
    start,
    end,
  );

  const dials = summaryQuery.data?.dials ?? [];
  const rows = analyticsQuery.data?.rows ?? [];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Compliance</h1>
        <div className="flex items-center gap-3">
          <Badge variant="outline">{selectedSiteId ? "Selected site" : "All sites"}</Badge>
          <PeriodToggle value={period} onChange={setPeriod} />
        </div>
      </div>

      <Card className="mb-6 border-primary/20 bg-primary/5">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" />
            Compliance dials
          </CardTitle>
          <p className="text-sm font-normal text-muted-foreground">
            Counters of equipment currently failing a rule of category{" "}
            <code className="rounded bg-muted px-1 text-xs">compliance</code>.
            Each dial fills from green (none failing) to red (more failing).
          </p>
        </CardHeader>
        <CardContent>
          {summaryQuery.isLoading ? (
            <Skeleton className="h-32 w-full rounded-xl" />
          ) : dials.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No fault rules of category "compliance" loaded. Add YAML rules
              with <code>category: compliance</code> in <code>rules_dir</code>.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {dials.map((d) => (
                <DialCard key={d.fault_id} dial={d} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Thermometer className="h-4 w-4" />
            Per-equipment compliance analytics
          </CardTitle>
          <p className="text-sm font-normal text-muted-foreground">
            Averages over the selected window. ΔT prefers air-side (return or
            zone − supply) and falls back to water-side. In-hours compliance %
            is the
            fraction of in-hours seconds during which no compliance rule was
            firing - 100 % if no schedule is configured yet.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {analyticsQuery.isLoading ? (
            <div className="p-4">
              <Skeleton className="h-48 w-full rounded-xl" />
            </div>
          ) : rows.length === 0 ? (
            <div className="px-6 py-6 text-sm text-muted-foreground">
              No equipment in scope for the selected period.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Equipment</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Avg ΔT</TableHead>
                  <TableHead className="text-right">Avg supply T</TableHead>
                  <TableHead className="text-right">Avg flow T</TableHead>
                  <TableHead className="text-right">In-hours comp.</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const supply =
                    r.avg_supply_air_t ?? r.avg_supply_water_t ?? null;
                  // "Flow temperature" in hydronic systems = supply water side.
                  // Falls back to the return/zone air side when no water sensors
                  // are present (zone air is the return-side proxy on units).
                  const flow =
                    r.avg_supply_water_t ??
                    r.avg_return_air_t ??
                    r.avg_zone_air_t ??
                    null;
                  return (
                    <TableRow key={r.equipment_id}>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {r.equipment_type ?? "-"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(r.avg_delta_t, 1, " °")}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(supply, 1, " °")}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(flow, 1, " °")}
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 tabular-nums",
                            r.in_hours_compliance_pct == null
                              ? "text-muted-foreground"
                              : r.in_hours_compliance_pct >= 95
                                ? "text-success"
                                : r.in_hours_compliance_pct >= 80
                                  ? "text-warning"
                                  : "text-destructive",
                          )}
                        >
                          <Gauge className="h-3.5 w-3.5" />
                          {formatNumber(r.in_hours_compliance_pct, 1, " %")}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
