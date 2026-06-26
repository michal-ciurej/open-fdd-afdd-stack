import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Wrench, CalendarClock, CheckCircle2, X, ChevronRight, Eye, FileText } from "lucide-react";
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
import { EngineerReportModal } from "@/components/maintenance/EngineerReportModal";
import { EquipmentHealthMatrix } from "@/components/maintenance/EquipmentHealthMatrix";
import {
  useLogMaintenanceEvent,
  useMaintenanceOverview,
} from "@/hooks/use-maintenance";
import type {
  MaintenanceEquipmentRow,
  MaintenanceEventType,
} from "@/types/api";
import { cn, timeAgo } from "@/lib/utils";

type Period = 7 | 30;

function FaultSparkline({
  values,
  maintainedTs,
  days,
}: {
  values: number[];
  maintainedTs: string | null;
  days: string[];
}) {
  const max = Math.max(1, ...values);
  const width = 180;
  const height = 28;
  const barWidth = values.length > 0 ? width / values.length : 0;
  const cutoffIndex = useMemo(() => {
    if (!maintainedTs) return -1;
    const day = maintainedTs.slice(0, 10);
    return days.indexOf(day);
  }, [maintainedTs, days]);

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label="Fault count over the observation window"
      className="overflow-visible"
    >
      {values.map((v, i) => {
        const h = (v / max) * height;
        return (
          <rect
            key={i}
            x={i * barWidth}
            y={height - h}
            width={Math.max(1, barWidth - 1)}
            height={h}
            className={cn(
              "transition-opacity",
              v > 0 ? "fill-destructive/70" : "fill-muted-foreground/20",
            )}
          />
        );
      })}
      {cutoffIndex >= 0 && (
        <line
          x1={(cutoffIndex + 0.5) * barWidth}
          x2={(cutoffIndex + 0.5) * barWidth}
          y1={-2}
          y2={height + 2}
          className="stroke-primary"
          strokeWidth={1.5}
          strokeDasharray="2 2"
        />
      )}
    </svg>
  );
}

function PeriodToggle({ value, onChange }: { value: Period; onChange: (v: Period) => void }) {
  const options: Period[] = [7, 30];
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
          {o} d
        </button>
      ))}
    </div>
  );
}

function EquipmentRowControls({ row }: { row: MaintenanceEquipmentRow }) {
  const log = useLogMaintenanceEvent();
  const fire = (event_type: MaintenanceEventType) =>
    log.mutate({ equipment_id: row.equipment_id, event_type });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => fire("scheduled")}
        disabled={log.isPending}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-background px-2.5 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-60"
      >
        <CalendarClock className="h-3.5 w-3.5" />
        Schedule
      </button>
      <button
        type="button"
        onClick={() => fire("maintained")}
        disabled={log.isPending}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-success/40 bg-success/10 px-2.5 text-xs font-medium text-success transition-colors hover:bg-success/20 disabled:opacity-60"
      >
        <CheckCircle2 className="h-3.5 w-3.5" />
        Mark maintained
      </button>
      {row.scheduled && (
        <button
          type="button"
          onClick={() => fire("cancelled")}
          disabled={log.isPending}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60"
        >
          <X className="h-3.5 w-3.5" />
          Cancel
        </button>
      )}
    </div>
  );
}

export function MaintenancePage() {
  const { selectedSiteId } = useSiteContext();
  const [period, setPeriod] = useState<Period>(30);
  const [reportOpen, setReportOpen] = useState(false);
  const { data, isLoading, isError } = useMaintenanceOverview(period);

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    if (!selectedSiteId) return all;
    return all.filter((r) => r.site_id === selectedSiteId);
  }, [data, selectedSiteId]);

  const scheduledRows = useMemo(
    () => rows.filter((r) => r.scheduled),
    [rows],
  );

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Maintenance</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setReportOpen(true)}
            disabled={scheduledRows.length === 0}
            title={
              scheduledRows.length === 0
                ? "Schedule equipment for maintenance to generate a report"
                : "Generate the engineer planner report"
            }
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border/60 bg-background px-3 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
            data-testid="generate-engineer-report"
          >
            <FileText className="h-4 w-4" />
            Generate Engineer Report
            {scheduledRows.length > 0 && (
              <span className="rounded-full bg-primary/10 px-1.5 text-xs font-semibold text-primary">
                {scheduledRows.length}
              </span>
            )}
          </button>
          <PeriodToggle value={period} onChange={setPeriod} />
        </div>
      </div>

      {reportOpen && (
        <EngineerReportModal
          items={scheduledRows.map((r) => ({
            equipment_id: r.equipment_id,
            site_id: r.site_id,
            name: r.name,
            equipment_type: r.equipment_type,
          }))}
          windowDays={period}
          siteId={selectedSiteId ?? undefined}
          onClose={() => setReportOpen(false)}
        />
      )}

      <Card className="mb-4 border-primary/20 bg-primary/5">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Eye className="h-4 w-4" />
            Equipment under observation ({isLoading ? "…" : rows.length})
          </CardTitle>
          <p className="text-sm font-normal text-muted-foreground">
            Equipment flagged for closer tracking on the Equipment detail page.
            Mark "Scheduled" when you book maintenance and "Maintained" when the
            work is done: the cutoff line on the timeline will show you when the piece was last maintained.
          </p>
        </CardHeader>
      </Card>

      {!isLoading && !isError && rows.length > 0 && (
        <EquipmentHealthMatrix rows={rows} period={period} />
      )}

      {isLoading ? (
        <Skeleton className="h-72 w-full rounded-2xl" />
      ) : isError ? (
        <Card><CardContent className="pt-6 text-sm text-destructive">Failed to load maintenance overview.</CardContent></Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No equipment is currently under observation. Open an equipment
            detail page and toggle "Mark for observation" to start tracking it
            here.
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Equipment</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last maintained</TableHead>
                <TableHead>Fault timeline ({period} d)</TableHead>
                <TableHead className="text-right">Actions</TableHead>
                <TableHead aria-label="Open detail" className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.equipment_id}>
                  <TableCell>
                    <div className="font-medium">{row.name}</div>
                    {row.equipment_type && (
                      <div className="font-mono text-xs text-muted-foreground">
                        {row.equipment_type}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {row.scheduled ? (
                      <Badge variant="warning" className="gap-1">
                        <Wrench className="h-3 w-3" /> Scheduled
                      </Badge>
                    ) : row.last_maintained_ts ? (
                      <Badge variant="success" className="gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Maintained
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.last_maintained_ts ? timeAgo(row.last_maintained_ts) : "never"}
                  </TableCell>
                  <TableCell>
                    <FaultSparkline
                      values={row.fault_histogram}
                      maintainedTs={row.last_maintained_ts}
                      days={row.histogram_days}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <EquipmentRowControls row={row} />
                  </TableCell>
                  <TableCell className="w-10 text-right">
                    <Link
                      to={`/equipment/${row.equipment_id}?site=${row.site_id}`}
                      aria-label={`Open ${row.name} detail`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
