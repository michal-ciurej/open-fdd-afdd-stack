import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { cellLevel } from "@/components/maintenance/equipment-health-matrix-utils";
import { useFaultTimeseries } from "@/hooks/use-faults";
import type { FaultDefinition } from "@/types/api";

// Same destructive heat ramp as the Equipment Health Quickview matrix, so both
// heatmaps read identically across the app.
const LEVEL_CLASS = [
  "bg-muted/50",
  "bg-destructive/25",
  "bg-destructive/45",
  "bg-destructive/65",
  "bg-destructive/85",
] as const;

interface FaultOverTimeHeatmapProps {
  siteId: string | undefined;
  definitions: FaultDefinition[];
  start: string;
  end: string;
  equipmentId: string;
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Inclusive list of calendar days (YYYY-MM-DD) spanning the window. */
function dayRange(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const s = new Date(`${startIso.slice(0, 10)}T00:00:00`);
  const e = new Date(`${endIso.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return out;
  for (const d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    out.push(dayKey(d));
  }
  return out;
}

function shortDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

/**
 * Issues-over-time heatmap for a single equipment. Rows = each unique issue
 * flagged in the window (worst first), columns = days, cell intensity = issue
 * count per day. Mirrors the Equipment Health Quickview matrix, but pivoted so
 * each row is one fault rule instead of one asset.
 */
export function FaultOverTimeHeatmap({
  siteId,
  definitions,
  start,
  end,
  equipmentId,
}: FaultOverTimeHeatmapProps) {
  const { data, isLoading, error } = useFaultTimeseries(siteId, start, end, "day", {
    equipmentIds: [equipmentId],
  });

  const defMap = useMemo(
    () => new Map(definitions.map((d) => [d.fault_id, d])),
    [definitions],
  );

  const { days, rows, max } = useMemo(() => {
    const series = data?.series ?? [];
    // Sum value per (fault_id, day); track per-fault totals for row ordering.
    const byFault = new Map<string, Map<string, number>>();
    const totals = new Map<string, number>();
    const present = new Set<string>();
    for (const r of series) {
      const day = r.time.slice(0, 10);
      present.add(day);
      const cells = byFault.get(r.metric) ?? new Map<string, number>();
      cells.set(day, (cells.get(day) ?? 0) + r.value);
      byFault.set(r.metric, cells);
      totals.set(r.metric, (totals.get(r.metric) ?? 0) + r.value);
    }
    // Column axis: the requested window, plus any day the data actually lands on.
    const days = Array.from(new Set([...dayRange(start, end), ...present])).sort();
    // Rows: only issues that were actually flagged (total > 0), worst first.
    const faultIds = Array.from(byFault.keys())
      .filter((id) => (totals.get(id) ?? 0) > 0)
      .sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
    let max = 0;
    for (const id of faultIds) {
      for (const v of byFault.get(id)!.values()) if (v > max) max = v;
    }
    const rows = faultIds.map((faultId) => ({
      faultId,
      total: totals.get(faultId) ?? 0,
      cells: byFault.get(faultId)!,
    }));
    return { days, rows, max };
  }, [data, start, end]);

  if (error) {
    return (
      <div className="flex h-40 items-center justify-center rounded-2xl border border-border/60 bg-card">
        <p className="text-sm text-destructive">Failed to load issue history.</p>
      </div>
    );
  }
  if (isLoading) {
    return <Skeleton className="h-40 w-full rounded-2xl" />;
  }
  if (rows.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-2xl border border-border/60 bg-card px-6 text-center">
        <p className="text-sm text-muted-foreground">
          No issues flagged in this period. FDD runs periodically; widen the range or run FDD to
          see results.
        </p>
      </div>
    );
  }

  const firstDay = days[0];
  const lastDay = days[days.length - 1];

  return (
    <div>
      {/* Day axis caption, aligned to the grid area (label column + gap spacer). */}
      <div className="mb-1 flex items-center gap-2">
        <span className="w-48 shrink-0" aria-hidden />
        <div className="flex flex-1 items-center justify-between text-[10px] text-muted-foreground">
          <span>{shortDay(firstDay)}</span>
          <span>{shortDay(lastDay)}</span>
        </div>
      </div>

      <div className="space-y-1">
        {rows.map((row) => {
          const def = defMap.get(row.faultId);
          const name = def?.name ?? row.faultId;
          return (
            <div key={row.faultId} className="flex items-center gap-2">
              <span
                title={`${name} · ${row.faultId} · ${row.total} issue${row.total === 1 ? "" : "s"}`}
                className="w-48 shrink-0 truncate text-sm font-medium"
              >
                {name}
              </span>
              <div
                className="grid flex-1 gap-px"
                style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
              >
                {days.map((day) => {
                  const v = row.cells.get(day) ?? 0;
                  return (
                    <div
                      key={day}
                      title={`${day}: ${v} issue${v === 1 ? "" : "s"} · ${name}`}
                      className={cn("h-4 rounded-[2px]", LEVEL_CLASS[cellLevel(v, max)])}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          Fewer
          {LEVEL_CLASS.map((c, i) => (
            <span key={i} className={cn("inline-block h-2.5 w-2.5 rounded-[2px]", c)} />
          ))}
          More issues
        </span>
      </div>
    </div>
  );
}
