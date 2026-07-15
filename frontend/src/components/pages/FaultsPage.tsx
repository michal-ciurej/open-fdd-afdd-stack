import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, ArrowUp, ArrowDown, ArrowRight } from "lucide-react";
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
  useSiteFaults,
  useEquipmentAttention,
} from "@/hooks/use-faults";
import { FaultOverTimeChart } from "@/components/dashboard/FaultOverTimeChart";
import { DateRangeSelect } from "@/components/site/DateRangeSelect";
import type { DatePreset } from "@/components/site/DateRangeSelect";
import type {
  FaultState,
  FaultDefinition,
  Equipment,
  Site,
  AttentionBand,
  AttentionEquipment,
  AttentionTrend,
  EquipmentAttentionResponse,
} from "@/types/api";

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

const pctOf = (p: number) => `${Math.round(p * 100)}%`;

/** Band-specific colour classes (semantic tokens, matched to severity styling). */
function bandTint(band: AttentionBand): { dot: string; bar: string } {
  switch (band) {
    case "attention":
      return { dot: "bg-destructive", bar: "bg-destructive" };
    case "degraded":
      return { dot: "bg-warning", bar: "bg-warning" };
    default:
      return { dot: "bg-success", bar: "bg-success" };
  }
}

function TrendPill({ trend }: { trend: AttentionTrend }) {
  const meta = {
    worsening: { icon: ArrowUp, label: "worsening", cls: "text-destructive" },
    improving: { icon: ArrowDown, label: "improving", cls: "text-success" },
    stable: { icon: ArrowRight, label: "stable", cls: "text-muted-foreground" },
  }[trend];
  const Icon = meta.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", meta.cls)}>
      <Icon className="h-3.5 w-3.5" />
      {meta.label}
    </span>
  );
}

function AttentionCard({
  unit,
  equipment,
}: {
  unit: AttentionEquipment;
  equipment: Equipment | undefined;
}) {
  const tint = bandTint(unit.band);
  const dom = unit.dominant;
  return (
    <div
      className="flex flex-col gap-0 overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm sm:flex-row"
      data-testid={`attention-row-${unit.id}`}
    >
      <div className="min-w-0 flex-1 p-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <Link
            to={`/equipment/${unit.id}`}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {unit.name}
          </Link>
          <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {unit.type ?? "Untyped"}
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-baseline gap-2 text-sm">
          <Badge variant={severityVariant(dom.severity)}>{dom.severity}</Badge>
          <span className="text-foreground/90">{dom.name}</span>
        </div>

        <div className="mt-2.5 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full", tint.bar)}
              style={{ width: pctOf(dom.persistence) }}
            />
          </div>
          <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
            fired in {pctOf(dom.persistence)} of checks
            {dom.days_active != null ? ` · ${dom.days_active} d` : ""}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {unit.faults.map((f) => (
            <Badge
              key={f.fault_id}
              variant={severityVariant(f.severity)}
              title={`${f.name} · severity ${f.severity} · fired in ${pctOf(f.persistence)} of checks`}
            >
              {f.name}
              <span className="ml-1.5 tabular-nums opacity-80">{pctOf(f.persistence)}</span>
            </Badge>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-border/60 p-4 sm:w-40 sm:flex-col sm:items-end sm:justify-between sm:border-l sm:border-t-0">
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums leading-none">
            {unit.score.toFixed(1)}
          </div>
          <div className="mt-1 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
            score
          </div>
        </div>
        <TrendPill trend={unit.trend} />
        <div className="flex items-center gap-2">
          <Link
            to={`/equipment/${unit.id}`}
            className="whitespace-nowrap text-xs text-primary underline-offset-2 hover:underline"
          >
            View trends →
          </Link>
          <ObservationEyeButton equipment={equipment} />
        </div>
      </div>
    </div>
  );
}

function KpiStrip({ data }: { data: EquipmentAttentionResponse }) {
  const delta = data.vs_last_period?.attention_delta ?? null;
  const deltaLabel =
    delta == null
      ? "—"
      : delta > 0
        ? `▲ ${delta} more`
        : delta < 0
          ? `▼ ${Math.abs(delta)} fewer`
          : "no change";
  const tiles = [
    {
      key: "attention",
      label: "Units needing attention",
      value: String(data.bands.attention),
      sub: `of ${data.bands.evaluated} evaluated`,
      accent: data.bands.attention > 0 ? "text-destructive" : "text-muted-foreground",
      stripe: data.bands.attention > 0 ? "bg-destructive" : "bg-border",
    },
    {
      key: "critical",
      label: "Critical faults active",
      value: String(data.critical_active),
      sub: data.critical_active === 1 ? "on 1 unit" : "across units",
      accent: "text-foreground",
      stripe: "bg-border",
    },
    {
      key: "system",
      label: "Worst-affected system",
      value: data.worst_system?.label ?? "—",
      sub: data.worst_system?.detail ?? "no units flagged",
      accent: "text-foreground",
      small: true,
      stripe: "bg-border",
    },
    {
      key: "delta",
      label: "vs last period",
      value: deltaLabel,
      sub:
        data.vs_last_period != null
          ? `was ${data.vs_last_period.prev} needing attention`
          : "no prior data",
      accent: delta && delta > 0 ? "text-warning-foreground" : "text-foreground",
      small: true,
      stripe: delta && delta > 0 ? "bg-warning" : "bg-border",
    },
  ];

  return (
    <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((t) => (
        <Card key={t.key} className="relative overflow-hidden">
          <span className={cn("absolute inset-y-0 left-0 w-1", t.stripe)} />
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">{t.label}</p>
            <p
              className={cn(
                "mt-1 font-semibold tabular-nums",
                t.small ? "text-xl" : "text-3xl",
                t.accent,
              )}
            >
              {t.value}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t.sub}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function AttentionSection({
  siteId,
  startDate,
  endDate,
}: {
  siteId: string | undefined;
  startDate: string;
  endDate: string;
}) {
  const { data, isLoading, error } = useEquipmentAttention(siteId, startDate, endDate);
  const { data: equipmentAll = [] } = useAllEquipment();
  const { data: equipmentSite = [] } = useEquipment(siteId);
  const equipment = siteId ? equipmentSite : equipmentAll;
  const equipById = useMemo(
    () => new Map(equipment.map((e) => [e.id, e])),
    [equipment],
  );
  const [showHealthy, setShowHealthy] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="text-sm text-destructive">Could not load equipment attention ranking.</div>
    );
  }

  const groups: { band: AttentionBand; label: string; dot: string }[] = [
    { band: "attention", label: "Needs attention now", dot: bandTint("attention").dot },
    { band: "degraded", label: "Degraded — plan a visit", dot: bandTint("degraded").dot },
  ];

  return (
    <>
      <KpiStrip data={data} />

      <section className="mb-8">
        <h2 className="mb-1 text-sm font-medium text-muted-foreground">
          Equipment needing attention
        </h2>
        <p className="mb-4 max-w-3xl text-xs text-muted-foreground">
          Ranked by a derived <span className="font-medium text-foreground">attention score</span> —
          each active fault weighted by its severity and by how persistently it's firing (share of
          FDD checks it fails), summed per unit. Worst first.
        </p>

        {data.equipment.length === 0 ? (
          <div className="rounded-xl border border-border/70 bg-muted/40 p-6 text-sm text-muted-foreground">
            No equipment needs attention in this time range.
          </div>
        ) : (
          groups.map((g) => {
            const units = data.equipment.filter((u) => u.band === g.band);
            if (units.length === 0) return null;
            return (
              <div key={g.band} className="mb-5">
                <div className="mb-2.5 flex items-center gap-2 text-sm font-semibold">
                  <span className={cn("h-2.5 w-2.5 rounded-full", g.dot)} />
                  {g.label}
                  <span className="font-normal text-muted-foreground">({units.length})</span>
                </div>
                <div className="flex flex-col gap-2.5">
                  {units.map((u) => (
                    <AttentionCard key={u.id} unit={u} equipment={equipById.get(u.id)} />
                  ))}
                </div>
              </div>
            );
          })
        )}

        {data.bands.healthy > 0 && (
          <div className="mt-4 rounded-xl border border-success/25 bg-success/10 px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className={cn("h-2.5 w-2.5 rounded-full", bandTint("healthy").dot)} />
              <span className="text-sm text-foreground/90">
                <span className="font-semibold text-success">{data.bands.healthy} units healthy</span>{" "}
                — no persistent faults in this period.
              </span>
              {data.healthy_sample.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowHealthy((v) => !v)}
                  className="ml-auto text-xs text-primary hover:underline"
                >
                  {showHealthy ? "Hide" : "Show sample"}
                </button>
              )}
            </div>
            {showHealthy && (
              <div className="mt-2.5 flex flex-wrap gap-2">
                {data.healthy_sample.map((n) => (
                  <span
                    key={n}
                    className="rounded-full border border-border bg-background px-2.5 py-0.5 text-xs text-muted-foreground"
                  >
                    {n}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </>
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

  // Native FDD-run resolution: one point per evaluated timestamp rather than a
  // date-truncated total, so individual runs are visible instead of a daily sum.
  const bucket = "raw" as const;
  const { data: definitions = [] } = useFaultDefinitions();

  return (
    <div className="flex flex-col">
      {/* Header: title + subtitle on the left, time range top-right. */}
      <header className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Issues</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Equipment health, derived from FDD rule runs — ranked so you know which units to
            send an engineer to first, not just how many alerts fired.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <DateRangeSelect
            preset={preset}
            onPresetChange={setPreset}
            customStart={customStart}
            customEnd={customEnd}
            onCustomStartChange={setCustomStart}
            onCustomEndChange={setCustomEnd}
          />
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {start.slice(0, 10)} → {end.slice(0, 10)}
          </span>
        </div>
      </header>

      <AttentionSection
        siteId={selectedSiteId ?? undefined}
        startDate={start}
        endDate={end}
      />

      <section className="mb-8">
        <h2 className="mb-1 text-sm font-medium text-muted-foreground">Issue flags over time</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Equipment flagged per issue at each FDD run (native resolution), not
          smoothed into daily totals.
        </p>
        <FaultOverTimeChart
          siteId={selectedSiteId ?? undefined}
          definitions={definitions}
          preset={preset}
          start={start}
          end={end}
          bucket={bucket}
        />
      </section>

      <section className="mt-2">
        <details className="rounded-2xl border border-border/60 bg-card shadow-sm">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
            All active issue rows{" "}
            <span className="font-normal text-muted-foreground">
              — full flat list for engineers (current state)
            </span>
          </summary>
          <div className="px-2 pb-2">
            {selectedSiteId ? <SiteFaultsView siteId={selectedSiteId} /> : <AllFaultsView />}
          </div>
        </details>
      </section>
    </div>
  );
}
