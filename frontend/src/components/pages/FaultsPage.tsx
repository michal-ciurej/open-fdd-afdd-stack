import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";
import { useSiteContext } from "@/contexts/site-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { updateEquipment } from "@/lib/crud-api";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import { timeAgo, severityVariant, isEquipmentObserved, cn } from "@/lib/utils";
import { useAllEquipment, useEquipment, useSite, useSites } from "@/hooks/use-sites";
import {
  useActiveFaults,
  useFaultDefinitions,
  useFaultSummary,
  useSiteFaults,
  useFaultCountsByEquipment,
} from "@/hooks/use-faults";
import { FaultOverTimeChart } from "@/components/dashboard/FaultOverTimeChart";
import { DateRangeSelect } from "@/components/site/DateRangeSelect";
import type { DatePreset } from "@/components/site/DateRangeSelect";
import type { FaultState, FaultDefinition, Equipment, Site } from "@/types/api";

function FaultsTable({
  faults,
  definitions,
  equipment,
  siteMap,
}: {
  faults: FaultState[];
  definitions: FaultDefinition[];
  equipment: Equipment[];
  siteMap?: Map<string, Site>;
}) {
  const defMap = useMemo(() => new Map(definitions.map((d) => [d.fault_id, d])), [definitions]);
  const equipById = useMemo(() => new Map(equipment.map((e) => [e.id, e])), [equipment]);
  const equipByName = useMemo(() => new Map(equipment.map((e) => [e.name, e])), [equipment]);
  const siteNames = useMemo(() => new Set(siteMap ? Array.from(siteMap.values()).map((s) => s.name) : []), [siteMap]);

  function deviceLabel(fault: FaultState): string {
    const equip = equipById.get(fault.equipment_id) ?? equipByName.get(fault.equipment_id);
    const base = equip ? equip.name : (siteMap && siteNames.has(fault.equipment_id) ? `Site: ${fault.equipment_id}` : fault.equipment_id);
    if (fault.bacnet_device_id != null && fault.bacnet_device_id !== "") {
      return `${base} (device ${fault.bacnet_device_id})`;
    }
    return base;
  }

  if (faults.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center" data-testid="faults-empty-state">
        <p className="text-sm text-muted-foreground">
          No active issues{siteMap ? " across any site" : " for this site"}.
        </p>
      </div>
    );
  }

  function sensorFromContext(context: Record<string, unknown> | null | undefined): string {
    if (!context || typeof context !== "object") return "-";
    const c = context as Record<string, unknown>;
    if (typeof c.point_external_id === "string") return c.point_external_id;
    if (typeof c.external_id === "string") return c.external_id;
    if (typeof c.sensor === "string") return c.sensor;
    if (typeof c.column === "string") return c.column;
    return "-";
  }

  return (
    <Table data-testid="faults-active-table">
      <TableHeader>
        <TableRow>
          {siteMap && <TableHead>Site</TableHead>}
          <TableHead>Device</TableHead>
          <TableHead>Issue</TableHead>
          <TableHead className="text-muted-foreground">Sensor / point</TableHead>
          <TableHead>Severity</TableHead>
          <TableHead className="w-[1%] whitespace-nowrap text-muted-foreground">Plots</TableHead>
          <TableHead className="text-right">Since</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {faults.map((fault) => {
          const def = defMap.get(fault.fault_id);
          const severity = def?.severity ?? "warning";
          const sensor = sensorFromContext(fault.context);

          return (
            <TableRow key={fault.id}>
              {siteMap && (
                <TableCell className="text-muted-foreground">
                  {siteMap.get(fault.site_id)?.name ?? fault.site_id.slice(0, 8)}
                </TableCell>
              )}
              <TableCell className="font-medium">
                {deviceLabel(fault)}
              </TableCell>
              <TableCell>{def?.name ?? fault.fault_id}</TableCell>
              <TableCell className="text-muted-foreground font-mono text-xs">
                {sensor}
              </TableCell>
              <TableCell>
                <Badge variant={severityVariant(severity)}>{severity}</Badge>
              </TableCell>
              <TableCell>
                {fault.bacnet_device_id != null && fault.bacnet_device_id !== "" ? (
                  <Link
                    className="text-xs text-primary underline-offset-2 hover:underline"
                    to={`/plots?${new URLSearchParams({
                      site: fault.site_id,
                      device: fault.bacnet_device_id,
                      fault: fault.fault_id,
                    }).toString()}`}
                  >
                    Trends
                  </Link>
                ) : (
                  <span className="text-xs text-muted-foreground">-</span>
                )}
              </TableCell>
              <TableCell className="text-right text-muted-foreground">
                {timeAgo(fault.last_changed_ts)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function AllFaultsView() {
  const { data: faults, isLoading } = useActiveFaults();
  const { data: definitions = [] } = useFaultDefinitions();
  const { data: equipment = [] } = useAllEquipment();
  const { data: sites = [] } = useSites();
  const siteMap = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);

  if (isLoading) return <Skeleton className="h-72 w-full rounded-2xl" />;

  return (
    <FaultsTable faults={faults ?? []} definitions={definitions} equipment={equipment} siteMap={siteMap} />
  );
}

function SiteFaultsView({ siteId }: { siteId: string }) {
  const { data: faults = [], isLoading } = useSiteFaults(siteId);
  const { data: definitions = [] } = useFaultDefinitions();
  const { data: equipment = [] } = useEquipment(siteId);
  const { data: site } = useSite(siteId);
  const siteMap = useMemo(
    () => (site ? new Map([[site.id, site]]) : undefined),
    [site],
  );

  if (isLoading) return <Skeleton className="h-72 w-full rounded-2xl" />;

  return (
    <FaultsTable
      faults={faults}
      definitions={definitions}
      equipment={equipment}
      siteMap={siteMap}
    />
  );
}

type EquipmentFaultRollup = {
  equipment_id: string;
  equipment_name: string;
  equipment_type: string | null;
  site_id: string;
  total_count: number;
  faults: {
    fault_id: string;
    fault_name: string;
    fault_severity: string;
    count: number;
  }[];
};

function ObservationEyeButton({ equipment }: { equipment: Equipment | undefined }) {
  const queryClient = useQueryClient();
  const observed = isEquipmentObserved(equipment);
  const mutation = useMutation({
    mutationFn: (nextObserved: boolean) => {
      if (!equipment) throw new Error("Equipment not found");
      return updateEquipment(equipment.id, { metadata: { observed: nextObserved } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["equipment"] });
    },
  });

  return (
    <button
      type="button"
      onClick={() => mutation.mutate(!observed)}
      disabled={!equipment || mutation.isPending}
      title={
        !equipment
          ? "Equipment not loaded"
          : observed
            ? "Stop tracking this equipment on the overview page"
            : "Track issue frequency on the overview page"
      }
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors",
        observed
          ? "border-warning/30 bg-warning/10 text-warning-foreground hover:bg-warning/20"
          : "border-border/60 bg-background text-muted-foreground hover:bg-muted",
        (!equipment || mutation.isPending) && "opacity-50",
      )}
      data-testid={`fault-counts-observe-${equipment?.id ?? "unknown"}`}
      aria-pressed={observed}
      aria-label={observed ? "Stop observing" : "Mark for observation"}
    >
      {observed ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
    </button>
  );
}

function FaultCountsByEquipmentSection({
  siteId,
  startDate,
  endDate,
}: {
  siteId: string | undefined;
  startDate: string;
  endDate: string;
}) {
  const { data, isLoading, error } = useFaultCountsByEquipment(
    siteId,
    startDate,
    endDate,
  );
  const { data: equipmentAll = [] } = useAllEquipment();
  const { data: equipmentSite = [] } = useEquipment(siteId);
  const equipment = siteId ? equipmentSite : equipmentAll;
  const equipById = useMemo(
    () => new Map(equipment.map((e) => [e.id, e])),
    [equipment],
  );

  const rollups: EquipmentFaultRollup[] = useMemo(() => {
    const rows = data?.rows ?? [];
    const acc = new Map<string, EquipmentFaultRollup>();
    for (const r of rows) {
      let entry = acc.get(r.equipment_id);
      if (!entry) {
        entry = {
          equipment_id: r.equipment_id,
          equipment_name: r.equipment_name,
          equipment_type: r.equipment_type,
          site_id: r.site_id,
          total_count: 0,
          faults: [],
        };
        acc.set(r.equipment_id, entry);
      }
      entry.total_count += r.count;
      entry.faults.push({
        fault_id: r.fault_id,
        fault_name: r.fault_name,
        fault_severity: r.fault_severity,
        count: r.count,
      });
    }
    const list = Array.from(acc.values());
    for (const e of list) e.faults.sort((a, b) => b.count - a.count);
    list.sort((a, b) => b.total_count - a.total_count);
    return list;
  }, [data]);

  if (isLoading) return <Skeleton className="h-40 w-full rounded-xl" />;
  if (error) {
    return (
      <div className="mb-8 text-sm text-destructive">
        Could not load per-equipment issue counts.
      </div>
    );
  }
  if (rollups.length === 0) {
    return (
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">
          Issue counts by equipment
        </h2>
        <div className="rounded-xl border border-border/70 bg-muted/40 p-6 text-sm text-muted-foreground">
          No issue rows in this time range.
        </div>
      </section>
    );
  }

  return (
    <section className="mb-8">
      <h2 className="mb-1 text-sm font-medium text-muted-foreground">
        Issue counts by equipment
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Ranked by total issue count - highest first. Mark equipment for
        observation to surface it on the overview page.
      </p>
      <Table data-testid="fault-counts-by-equipment-table">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[1%] whitespace-nowrap text-muted-foreground">#</TableHead>
            <TableHead>Equipment</TableHead>
            <TableHead>Issues</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead className="w-[1%] whitespace-nowrap text-right">Observe</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rollups.map((row, idx) => {
            const equip = equipById.get(row.equipment_id);
            return (
              <TableRow
                key={row.equipment_id}
                data-testid={`fault-counts-row-${row.equipment_id}`}
              >
                <TableCell className="text-muted-foreground tabular-nums">
                  {idx + 1}
                </TableCell>
                <TableCell>
                  <Link
                    to={`/equipment/${row.equipment_id}`}
                    className="font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {row.equipment_name}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {row.equipment_type ?? "-"}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1.5">
                    {row.faults.map((f) => (
                      <Badge
                        key={f.fault_id}
                        variant={severityVariant(f.fault_severity)}
                        title={`${f.fault_name} · severity ${f.fault_severity}`}
                      >
                        {f.fault_name}
                        <span className="ml-1.5 tabular-nums opacity-80">
                          {f.count}
                        </span>
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono font-medium tabular-nums">
                  {row.total_count}
                </TableCell>
                <TableCell className="text-right">
                  <ObservationEyeButton equipment={equip} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function formatLocalDT(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

function presetRange(preset: DatePreset): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  switch (preset) {
    case "24h":
      start.setHours(start.getHours() - 24);
      break;
    case "7d":
      start.setDate(start.getDate() - 7);
      break;
    case "30d":
      start.setDate(start.getDate() - 30);
      break;
    default:
      start.setDate(start.getDate() - 7);
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

function labelForPreset(preset: DatePreset): string {
  switch (preset) {
    case "24h":
      return "last 24 h";
    case "7d":
      return "last 7 d";
    case "30d":
      return "last 30 d";
    case "custom":
    default:
      return "custom range";
  }
}

export function FaultsPage() {
  const { selectedSiteId } = useSiteContext();
  const [preset, setPreset] = useState<DatePreset>("7d");
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [customStart, setCustomStart] = useState(formatLocalDT(weekAgo));
  const [customEnd, setCustomEnd] = useState(formatLocalDT(now));

  const { start, end } = useMemo(() => {
    if (preset === "custom") {
      return {
        start: new Date(customStart).toISOString(),
        end: new Date(customEnd).toISOString(),
      };
    }
    return presetRange(preset);
  }, [preset, customStart, customEnd]);

  const bucket: "hour" | "day" = preset === "24h" ? "hour" : "day";
  const { data: definitions = [] } = useFaultDefinitions();
  const { data: summary } = useFaultSummary(
    selectedSiteId ?? undefined,
    start,
    end,
  );
  const periodLabel = labelForPreset(preset);

  return (
    <div className="flex flex-col">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">Issues</h1>

      {/* Time range bar at top: all summary and charts below use this range */}
      <header className="mb-6 flex flex-wrap items-center gap-4 rounded-xl border border-border/80 bg-muted/70 px-4 py-3 shadow-sm">
        <span className="text-sm font-semibold text-foreground">Time range</span>
        <DateRangeSelect
          preset={preset}
          onPresetChange={setPreset}
          customStart={customStart}
          customEnd={customEnd}
          onCustomStartChange={setCustomStart}
          onCustomEndChange={setCustomEnd}
        />
        <span className="font-mono text-sm text-muted-foreground tabular-nums">
          {start.slice(0, 10)} → {end.slice(0, 10)}
        </span>
      </header>

      {summary != null && (
        <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Active issues in period ({periodLabel})</p>
              <p
                className={`mt-1 text-3xl font-semibold tabular-nums ${
                  (summary.active_in_period ?? summary.total_faults ?? 0) > 0
                    ? "text-destructive"
                    : "text-muted-foreground"
                }`}
              >
                {summary.active_in_period ?? summary.total_faults ?? 0}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Distinct (site + device + issue) in range. From FDD rule runs (fault_results).
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">Issue flags over time</h2>
        <FaultOverTimeChart
          siteId={selectedSiteId ?? undefined}
          definitions={definitions}
          preset={preset}
          start={start}
          end={end}
          bucket={bucket}
        />
      </section>

      <FaultCountsByEquipmentSection
        siteId={selectedSiteId ?? undefined}
        startDate={start}
        endDate={end}
      />

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">Active issue rows (current state)</h2>
        {selectedSiteId ? <SiteFaultsView siteId={selectedSiteId} /> : <AllFaultsView />}
      </section>
    </div>
  );
}
