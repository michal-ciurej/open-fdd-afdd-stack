import { useMemo } from "react";
import { AlertTriangle, Cpu, Wrench } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useFaultCountsByEquipment } from "@/hooks/use-faults";
import { cn } from "@/lib/utils";
import { EngineerReportTimeseriesChart } from "./EngineerReportTimeseriesChart";

/** Minimal shape the report needs per equipment — satisfied by maintenance
 *  rows, equipment lists, etc. so the report can be reused in several places. */
export interface EngineerReportEquipmentItem {
  equipment_id: string;
  site_id: string;
  name: string;
  equipment_type: string | null;
}

interface FaultTally {
  fault_id: string;
  fault_name: string;
  count: number;
}

const UNTYPED = "Other equipment";

interface EngineerReportProps {
  items: EngineerReportEquipmentItem[];
  /** Look-back window in days for charts and fault counts. */
  windowDays: number;
  /** Scopes the fault-count query; omit to span all sites. */
  siteId?: string;
  className?: string;
}

function FaultGrid({
  faults,
  isLoading,
}: {
  faults: FaultTally[];
  isLoading: boolean;
}) {
  if (isLoading) {
    return <Skeleton className="h-16 w-full rounded-lg" />;
  }
  if (faults.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No faults recorded in this window.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {faults.map((f) => (
        <div
          key={f.fault_id}
          className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2"
        >
          <span className="truncate text-sm" title={f.fault_name}>
            {f.fault_name}
          </span>
          <span className="shrink-0 rounded-md bg-destructive/10 px-2 py-0.5 text-sm font-semibold tabular-nums text-destructive">
            {f.count}
          </span>
        </div>
      ))}
    </div>
  );
}

function EquipmentReportCard({
  item,
  windowDays,
  faults,
  faultsLoading,
}: {
  item: EngineerReportEquipmentItem;
  windowDays: number;
  faults: FaultTally[];
  faultsLoading: boolean;
}) {
  return (
    <section className="engineer-report-card rounded-2xl border border-border/60 bg-card p-5 shadow-sm">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold tracking-tight">{item.name}</h3>
          <p className="font-mono text-xs text-muted-foreground">
            {item.equipment_id}
          </p>
        </div>
        {item.equipment_type && (
          <span className="rounded-md border border-border/60 px-2 py-0.5 font-mono text-xs text-muted-foreground">
            {item.equipment_type}
          </span>
        )}
      </header>

      <div className="mb-4">
        <EngineerReportTimeseriesChart
          siteId={item.site_id}
          equipmentId={item.equipment_id}
          windowDays={windowDays}
        />
      </div>

      <div>
        <h4 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5" />
          Faults (last {windowDays} d)
        </h4>
        <FaultGrid faults={faults} isLoading={faultsLoading} />
      </div>
    </section>
  );
}

/**
 * Engineer Planner report: a stack of equipment cards grouped by equipment type
 * with separators between groups. Each card shows the equipment ID, a full-width
 * timeseries chart, and a grid of fault names + counts. Designed to be embedded
 * in a modal, a page, or printed to PDF.
 */
export function EngineerReport({
  items,
  windowDays,
  siteId,
  className,
}: EngineerReportProps) {
  const { start, end } = useMemo(() => {
    const e = new Date();
    const s = new Date();
    s.setDate(s.getDate() - windowDays);
    return { start: s.toISOString(), end: e.toISOString() };
  }, [windowDays]);

  const { data: faultCounts, isLoading: faultsLoading } =
    useFaultCountsByEquipment(siteId, start, end);

  /** equipment_id → fault tallies, sorted by count desc. */
  const faultsByEquipment = useMemo(() => {
    const m = new Map<string, FaultTally[]>();
    for (const row of faultCounts?.rows ?? []) {
      const arr = m.get(row.equipment_id) ?? [];
      arr.push({
        fault_id: row.fault_id,
        fault_name: row.fault_name,
        count: row.count,
      });
      m.set(row.equipment_id, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => b.count - a.count);
    return m;
  }, [faultCounts]);

  /** Items grouped by equipment type, groups sorted alphabetically. */
  const groups = useMemo(() => {
    const m = new Map<string, EngineerReportEquipmentItem[]>();
    for (const item of items) {
      const key = item.equipment_type ?? UNTYPED;
      const arr = m.get(key) ?? [];
      arr.push(item);
      m.set(key, arr);
    }
    return Array.from(m.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, groupItems]) => ({
        type,
        items: groupItems
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }, [items]);

  if (items.length === 0) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-2xl border border-border/60 bg-card px-6 py-12 text-center",
          className,
        )}
      >
        <Wrench className="h-6 w-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No equipment scheduled for maintenance</p>
        <p className="text-sm text-muted-foreground">
          Mark equipment as "Scheduled" on the maintenance overview to include it
          in the engineer report.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("space-y-8", className)}>
      {groups.map((group) => (
        <div key={group.type}>
          <div className="mb-4 flex items-center gap-3">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {group.type}
            </h2>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {group.items.length}
            </span>
            <div className="h-px flex-1 bg-border/60" />
          </div>
          <div className="space-y-5">
            {group.items.map((item) => (
              <EquipmentReportCard
                key={item.equipment_id}
                item={item}
                windowDays={windowDays}
                faults={faultsByEquipment.get(item.equipment_id) ?? []}
                faultsLoading={faultsLoading}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
