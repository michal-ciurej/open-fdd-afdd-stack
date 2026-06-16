import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { MaintenanceEquipmentRow } from "@/types/api";
import {
  cellLevel,
  maintenanceCutoffIndex,
  matrixMax,
  sortByFaultLoad,
} from "./equipment-health-matrix-utils";

const LEVEL_CLASS = [
  "bg-muted/50",
  "bg-destructive/25",
  "bg-destructive/45",
  "bg-destructive/65",
  "bg-destructive/85",
] as const;

function shortDay(iso: string): string {
  // histogram_days are YYYY-MM-DD; show "D Mon".
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

interface EquipmentHealthMatrixProps {
  rows: MaintenanceEquipmentRow[];
  period: number;
}

/**
 * Viz 1 — Equipment Health Matrix. Rows = observed equipment (worst-faulting
 * first), columns = days. Cell intensity tracks daily fault count; a marker
 * frames the day each asset was last maintained so the before/after effect of
 * an intervention is visible at a glance.
 */
export function EquipmentHealthMatrix({ rows, period }: EquipmentHealthMatrixProps) {
  const sorted = useMemo(() => sortByFaultLoad(rows), [rows]);
  const max = useMemo(() => matrixMax(rows), [rows]);

  if (rows.length === 0) return null;

  // Use the first row's day axis as the shared header (all rows share the window).
  const days = sorted[0]?.histogram_days ?? [];
  const n = days.length;
  const firstDay = days[0];
  const lastDay = days[n - 1];

  return (
    <Card className="mb-4 overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Equipment health matrix ({period} d)</CardTitle>
        <p className="text-sm font-normal text-muted-foreground">
          Daily fault density per observed asset, worst first. The ringed cell marks when an
          asset was last maintained — watch the band to its right cool down if the fix held.
        </p>
      </CardHeader>
      <CardContent>
        {/* Day axis caption */}
        {n > 0 && (
          <div className="mb-1 flex items-center justify-between pl-44 text-[10px] text-muted-foreground">
            <span>{shortDay(firstDay)}</span>
            <span>{shortDay(lastDay)}</span>
          </div>
        )}

        <div className="space-y-1">
          {sorted.map((row) => {
            const cutoff = maintenanceCutoffIndex(row.last_maintained_ts, row.histogram_days);
            return (
              <div key={row.equipment_id} className="flex items-center gap-2">
                <Link
                  to={`/equipment/${row.equipment_id}?site=${row.site_id}`}
                  title={`${row.name}${row.equipment_type ? ` · ${row.equipment_type}` : ""}`}
                  className="w-44 shrink-0 truncate text-sm font-medium text-primary underline-offset-2 hover:underline"
                >
                  {row.name}
                </Link>
                <div
                  className="grid flex-1 gap-px"
                  style={{ gridTemplateColumns: `repeat(${row.fault_histogram.length}, minmax(0, 1fr))` }}
                >
                  {row.fault_histogram.map((v, i) => (
                    <div
                      key={i}
                      title={`${row.histogram_days[i] ?? ""}: ${v} fault${v === 1 ? "" : "s"}${
                        i === cutoff ? " · maintained" : ""
                      }`}
                      className={cn(
                        "h-4 rounded-[2px]",
                        LEVEL_CLASS[cellLevel(v, max)],
                        i === cutoff && "ring-2 ring-primary ring-offset-1 ring-offset-card",
                      )}
                    />
                  ))}
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
            More faults
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-muted/50 ring-2 ring-primary" />
            Last maintained
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
