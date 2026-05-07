import { useMemo, useState } from "react";
import type React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Wind, Building2, Snowflake, AlertTriangle, Search } from "lucide-react";
import { useSiteContext } from "@/contexts/site-context";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DateRangeSelect } from "@/components/site/DateRangeSelect";
import type { DatePreset } from "@/components/site/DateRangeSelect";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { EquipmentFaultCountsResponse } from "@/types/api";
import { Badge } from "@/components/ui/badge";

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

function formatLocalDT(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

type EquipPill = "all" | "Fan_Coil_Unit" | "Air_Handling_Unit" | "Chiller" | "active";

const PILL_DEFS: {
  id: EquipPill;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  equipmentType?: string;
  activeOnly?: boolean;
}[] = [
  { id: "all", label: "All", icon: Search },
  { id: "Fan_Coil_Unit", label: "Fan Coil Units", icon: Wind, equipmentType: "Fan_Coil_Unit" },
  { id: "Air_Handling_Unit", label: "Air Handling Units", icon: Building2, equipmentType: "Air_Handling_Unit" },
  { id: "Chiller", label: "Chillers", icon: Snowflake, equipmentType: "Chiller" },
  { id: "active", label: "Units with active faults", icon: AlertTriangle, activeOnly: true },
] as const;

export function EquipmentPage() {
  const { selectedSiteId } = useSiteContext();
  const [pill, setPill] = useState<EquipPill>("all");
  const [search, setSearch] = useState("");

  const [preset, setPreset] = useState<DatePreset>("7d");
  const now = useMemo(() => new Date(), []);
  const weekAgo = useMemo(() => {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    return d;
  }, [now]);
  const [customStart, setCustomStart] = useState(formatLocalDT(weekAgo));
  const [customEnd, setCustomEnd] = useState(formatLocalDT(now));

  const { startDate, endDate } = useMemo(() => {
    if (preset === "custom") {
      return {
        startDate: toDateOnly(new Date(customStart).toISOString()),
        endDate: toDateOnly(new Date(customEnd).toISOString()),
      };
    }
    const r = presetRange(preset);
    return { startDate: toDateOnly(r.start), endDate: toDateOnly(r.end) };
  }, [preset, customStart, customEnd]);

  const pillDef = PILL_DEFS.find((p) => p.id === pill) ?? PILL_DEFS[0];
  const equipmentType = pillDef.equipmentType;
  const activeOnly = pillDef.activeOnly === true;

  const pageSize = 50;
  const query = useInfiniteQuery<EquipmentFaultCountsResponse>({
    queryKey: [
      "equipment",
      "fault-counts",
      selectedSiteId ?? "all",
      startDate,
      endDate,
      equipmentType ?? "",
      activeOnly ? "activeOnly" : "",
      search,
    ],
    queryFn: ({ pageParam }) => {
      const offset = typeof pageParam === "number" ? pageParam : 0;
      const sp = new URLSearchParams();
      if (selectedSiteId) sp.set("site_id", selectedSiteId);
      sp.set("start_date", startDate);
      sp.set("end_date", endDate);
      if (equipmentType) sp.set("equipment_type", equipmentType);
      if (activeOnly) sp.set("active_faults_only", "true");
      if (search.trim()) sp.set("q", search.trim());
      sp.set("limit", String(pageSize));
      sp.set("offset", String(offset));
      return apiFetch<EquipmentFaultCountsResponse>(
        `/analytics/equipment-fault-counts?${sp.toString()}`,
      );
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const next = lastPage.paging.offset + lastPage.paging.limit;
      return next < lastPage.paging.total ? next : undefined;
    },
    enabled: !!startDate && !!endDate,
    staleTime: 30 * 1000,
  });

  const rows = useMemo(
    () => query.data?.pages.flatMap((p) => p.rows) ?? [],
    [query.data],
  );
  const total = query.data?.pages?.[0]?.paging?.total ?? 0;

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Equipment</h1>

      <Card className="mb-6 border-primary/20 bg-primary/5">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Search className="h-5 w-5" />
            Browse your equipment
          </CardTitle>
          <p className="text-sm font-normal text-muted-foreground">
            Use one-click filters, search, and a time window to see how many faults were detected per unit.
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            {PILL_DEFS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setPill(id)}
                aria-pressed={pill === id}
                className={`inline-flex items-center gap-2 rounded-lg border border-border/60 bg-background px-4 py-2.5 text-sm font-medium transition-colors hover:bg-muted ${
                  pill === id ? "ring-2 ring-primary/30" : ""
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">
                {selectedSiteId ? "Selected site" : "All sites"}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex-1">
          <div className="relative max-w-xl">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search equipment name…"
              className="h-10 w-full rounded-xl border border-border/60 bg-card pl-10 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>
        </div>
        <DateRangeSelect
          preset={preset}
          onPresetChange={setPreset}
          customStart={customStart}
          customEnd={customEnd}
          onCustomStartChange={setCustomStart}
          onCustomEndChange={setCustomEnd}
        />
      </div>

      <div className="rounded-[var(--radius)]">
        {query.isLoading ? (
          <div className="p-4">
            <Skeleton className="h-64 w-full rounded-2xl" />
          </div>
        ) : query.isError ? (
          <div className="p-4 text-sm text-destructive">
            Failed to load equipment list.
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between px-4 py-3 text-sm">
              <div className="text-muted-foreground">
                Showing <span className="font-medium text-foreground">{rows.length}</span>
                {total ? (
                  <>
                    {" "}
                    of <span className="font-medium text-foreground">{total}</span>
                  </>
                ) : null}{" "}
                units
              </div>
              <div className="text-muted-foreground">
                Window: <span className="font-medium text-foreground">{startDate}</span> →{" "}
                <span className="font-medium text-foreground">{endDate}</span>
              </div>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Equipment</TableHead>
                  <TableHead>Type</TableHead>
                  {!selectedSiteId && <TableHead>Site</TableHead>}
                  <TableHead className="text-right">Faults in window</TableHead>
                  <TableHead className="text-right">Active now</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={selectedSiteId ? 4 : 5}
                      className="py-10 text-center text-sm text-muted-foreground"
                    >
                      No equipment found for the selected filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {r.equipment_type ?? "—"}
                      </TableCell>
                      {!selectedSiteId && (
                        <TableCell className="text-sm text-muted-foreground">
                          {r.site_name}
                        </TableCell>
                      )}
                      <TableCell className="text-right font-medium tabular-nums">
                        {r.fault_count_in_period}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.active_fault_count > 0 ? (
                          <Badge variant="destructive">{r.active_fault_count}</Badge>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>

            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="text-xs text-muted-foreground">
                Page size: <span className="font-medium text-foreground">{pageSize}</span>
              </div>
              <div className="flex items-center gap-2">
                {query.hasNextPage ? (
                  <button
                    type="button"
                    onClick={() => void query.fetchNextPage()}
                    disabled={query.isFetchingNextPage}
                    className="inline-flex h-9 items-center justify-center rounded-lg border border-border/60 bg-background px-3 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-60"
                  >
                    {query.isFetchingNextPage ? "Loading…" : "Load more"}
                  </button>
                ) : (
                  <span className="text-sm text-muted-foreground">End of list</span>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
