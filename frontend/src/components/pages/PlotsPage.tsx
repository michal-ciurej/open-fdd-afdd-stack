import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useSiteContext } from "@/contexts/site-context";
import { usePoints, useEquipment } from "@/hooks/use-sites";
import { useTimeseriesLatest } from "@/hooks/use-timeseries-latest";
import { useFaultDefinitions, useFaultTimeseries, useFaultState } from "@/hooks/use-faults";
import type { FaultDefinition, Equipment, Point } from "@/types/api";
import { DateRangeSelect } from "@/components/site/DateRangeSelect";
import type { DatePreset } from "@/components/site/DateRangeSelect";
import { Skeleton } from "@/components/ui/skeleton";
import { downloadTimeseriesCsv, fetchCsv } from "@/lib/csv";
import {
  inferYColumns,
  joinFaultSignals,
  parseCsvText,
  pickFaultBucket,
  type ParsedCsv,
} from "@/lib/plots-csv";
import { ChartLine, ChevronDown, Download, RefreshCw } from "lucide-react";

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

const PLOT_COLORS = [
  "#1d4ed8",
  "#be185d",
  "#15803d",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#b91c1c",
  "#4d7c0f",
];

type PlotMode = "lines" | "points" | "both";
function toDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function equipmentLabel(eq: Equipment): string {
  if (eq.equipment_type && eq.equipment_type !== eq.name) {
    return `${eq.name} (${eq.equipment_type})`;
  }
  return eq.name;
}

function pointLabel(p: Point): string {
  return p.object_name ?? p.external_id;
}

function PlotlyCanvas({
  traces,
  title,
}: {
  traces: Record<string, unknown>[];
  title: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let mounted = true;
    async function draw() {
      if (!ref.current) return;
      const Plotly = (await import("plotly.js-dist-min")).default as {
        react: (el: HTMLDivElement, data: unknown[], layout: unknown, config: unknown) => void;
      };
      if (!mounted || !ref.current) return;
      Plotly.react(
        ref.current,
        traces,
        {
          title,
          autosize: true,
          margin: { t: 50, r: 24, b: 48, l: 56 },
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          xaxis: { title: "X", automargin: true },
          yaxis: { title: "Value", automargin: true },
          yaxis2: { title: "Fault 0/1", overlaying: "y", side: "right", range: [0, 1.1] },
          legend: { orientation: "h" },
        },
        {
          responsive: true,
          displaylogo: false,
          modeBarButtonsToRemove: ["lasso2d", "select2d"],
        },
      );
    }
    void draw();
    return () => {
      mounted = false;
    };
  }, [traces, title]);
  return <div ref={ref} className="h-[62vh] min-h-[420px] w-full rounded-lg border border-border/60 bg-card" />;
}

interface EquipmentComboboxProps {
  options: Equipment[];
  selectedId: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

function EquipmentCombobox({ options, selectedId, onChange, disabled }: EquipmentComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const selected = options.find((o) => o.id === selectedId) ?? null;
  const lower = search.toLowerCase();
  const filtered = options.filter((eq) => {
    if (!search) return true;
    return (
      eq.name.toLowerCase().includes(lower) ||
      (eq.equipment_type?.toLowerCase().includes(lower) ?? false) ||
      (eq.description?.toLowerCase().includes(lower) ?? false)
    );
  });

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        className="inline-flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border/60 bg-background px-3 text-left text-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="truncate">
          {selected ? equipmentLabel(selected) : options.length === 0 ? "No equipment available" : "Select equipment\u2026"}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-1.5 w-full min-w-[18rem] rounded-xl border border-border bg-card shadow-xl">
          <div className="border-b border-border p-2">
            <input
              type="text"
              placeholder="Search equipment by name or type\u2026"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              autoFocus
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">No matches.</div>
            ) : (
              filtered.map((eq) => {
                const active = eq.id === selectedId;
                return (
                  <button
                    key={eq.id}
                    type="button"
                    onClick={() => {
                      onChange(eq.id);
                      setOpen(false);
                      setSearch("");
                    }}
                    className={`flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/60 ${active ? "bg-muted/80" : ""}`}
                  >
                    <span className="truncate font-medium">{eq.name}</span>
                    {eq.equipment_type && (
                      <span className="truncate text-xs text-muted-foreground">{eq.equipment_type}</span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function PlotsPage() {
  const { selectedSiteId } = useSiteContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlPlotEquipment = searchParams.get("equipment") ?? "";
  const urlPlotFault = searchParams.get("fault") ?? "";
  const { data: points = [], isLoading: ptsLoading } = usePoints(selectedSiteId ?? undefined);
  const { data: equipment = [], isLoading: eqLoading } = useEquipment(selectedSiteId ?? undefined);
  const { data: latestList = [] } = useTimeseriesLatest(selectedSiteId ?? undefined);
  const { data: faultState = [] } = useFaultState(selectedSiteId ?? undefined);
  const { data: faultDefinitions = [] } = useFaultDefinitions();

  const historyPointIds = useMemo(
    () => new Set(latestList.map((r) => r.point_id)),
    [latestList],
  );

  const [plotMode, setPlotMode] = useState<PlotMode>("lines");
  const [showFaultOverlays, setShowFaultOverlays] = useState(true);
  const [selectedEquipmentId, setSelectedEquipmentId] = useState<string>("");
  const [selectedPointIds, setSelectedPointIds] = useState<string[]>([]);
  const [selectedFaultId, setSelectedFaultId] = useState<string>("");
  const [loadingCsv, setLoadingCsv] = useState(false);
  const [downloadingCsv, setDownloadingCsv] = useState(false);
  const [parsedCsv, setParsedCsv] = useState<ParsedCsv | null>(null);
  const [yColumns, setYColumns] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const prevSiteIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      prevSiteIdRef.current != null &&
      prevSiteIdRef.current !== selectedSiteId
    ) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("equipment");
          next.delete("fault");
          return next;
        },
        { replace: true },
      );
    }
    prevSiteIdRef.current = selectedSiteId;
  }, [selectedSiteId, setSearchParams]);

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

  const pointsByEquipmentId = useMemo(() => {
    const m = new Map<string, Point[]>();
    for (const p of points) {
      if (!p.equipment_id) continue;
      const arr = m.get(p.equipment_id) ?? [];
      arr.push(p);
      m.set(p.equipment_id, arr);
    }
    return m;
  }, [points]);

  /** Equipment with at least one point attached — nothing to plot otherwise. */
  const equipmentOptions = useMemo(() => {
    return equipment
      .filter((eq) => (pointsByEquipmentId.get(eq.id)?.length ?? 0) > 0)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [equipment, pointsByEquipmentId]);

  const pointsForEquipment = useMemo(() => {
    if (!selectedEquipmentId) return [] as Point[];
    const arr = pointsByEquipmentId.get(selectedEquipmentId) ?? [];
    return arr.slice().sort((a, b) => pointLabel(a).localeCompare(pointLabel(b)));
  }, [pointsByEquipmentId, selectedEquipmentId]);

  const faultIdsForEquipment = useMemo(() => {
    if (!selectedEquipmentId) return [] as string[];
    const set = new Set<string>();
    for (const f of faultState) {
      if (f.equipment_id !== selectedEquipmentId) continue;
      const fid = String(f.fault_id ?? "");
      if (fid) set.add(fid);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [faultState, selectedEquipmentId]);

  const faultDefById = useMemo(() => {
    const m = new Map<string, FaultDefinition>();
    for (const d of faultDefinitions) {
      if (d.fault_id) m.set(d.fault_id, d);
    }
    return m;
  }, [faultDefinitions]);

  const faultOptionLabel = useCallback(
    (faultId: string) => {
      const def = faultDefById.get(faultId);
      return def ? `${def.name} (${faultId})` : faultId;
    },
    [faultDefById],
  );

  const pointIdsForExport =
    selectedPointIds.length > 0
      ? selectedPointIds
      : pointsForEquipment.filter((p) => historyPointIds.has(p.id)).map((p) => p.id);

  const pointSelectionKey = useMemo(() => {
    return [...pointIdsForExport].sort().join("\0");
  }, [pointIdsForExport]);

  const faultBucket = pickFaultBucket(start, end);
  const equipmentIdsForFaultOverlay = useMemo(
    () => (selectedEquipmentId ? [selectedEquipmentId] : []),
    [selectedEquipmentId],
  );
  const { data: faultData } = useFaultTimeseries(selectedSiteId ?? undefined, start, end, faultBucket, {
    enabled: !!(
      selectedSiteId &&
      selectedFaultId &&
      start &&
      end &&
      equipmentIdsForFaultOverlay.length > 0
    ),
    equipmentIds: equipmentIdsForFaultOverlay,
  });

  const onCsvLoaded = useCallback((text: string) => {
    const parsed = parseCsvText(text);
    setParsedCsv(parsed);
    const x = "timestamp";
    setYColumns(inferYColumns(parsed, x));
    setError(null);
  }, []);

  /** Drop loaded CSV when load inputs change so we never join fault data onto a stale export. */
  useEffect(() => {
    setParsedCsv(null);
    setYColumns([]);
  }, [selectedSiteId, selectedEquipmentId, start, end, pointSelectionKey]);

  const loadOpenFddCsv = useCallback(async () => {
    if (!selectedSiteId) return;
    setLoadingCsv(true);
    try {
      const csv = await fetchCsv({
        site_id: selectedSiteId,
        start_date: toDateOnly(start),
        end_date: toDateOnly(end),
        format: "wide",
        point_ids: pointIdsForExport.length > 0 ? pointIdsForExport : undefined,
      });
      onCsvLoaded(csv);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load CSV from Open-FDD.");
    } finally {
      setLoadingCsv(false);
    }
  }, [selectedSiteId, start, end, pointIdsForExport, onCsvLoaded]);

  const selectedEquipment = useMemo(
    () => equipmentOptions.find((e) => e.id === selectedEquipmentId) ?? null,
    [equipmentOptions, selectedEquipmentId],
  );

  const downloadExcelCsv = useCallback(async () => {
    if (!selectedSiteId || pointIdsForExport.length === 0) return;
    setDownloadingCsv(true);
    setError(null);
    try {
      const startD = toDateOnly(start);
      const endD = toDateOnly(end);
      const eqSlug = selectedEquipment
        ? selectedEquipment.name.replace(/[^a-zA-Z0-9._-]+/g, "_")
        : "equipment";
      await downloadTimeseriesCsv(
        {
          site_id: selectedSiteId,
          start_date: startD,
          end_date: endD,
          format: "wide",
          point_ids: pointIdsForExport,
        },
        `openfdd_plots_${eqSlug}_${startD}_${endD}.csv`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to download CSV.");
    } finally {
      setDownloadingCsv(false);
    }
  }, [selectedSiteId, start, end, pointIdsForExport, selectedEquipment]);

  const effectiveCsv = useMemo(() => {
    if (!parsedCsv || !selectedFaultId) return parsedCsv;
    const faults = (faultData?.series ?? []).filter((f) => String(f.metric) === selectedFaultId);
    return joinFaultSignals(parsedCsv, "timestamp", faults, faultBucket);
  }, [parsedCsv, selectedFaultId, faultData, faultBucket]);

  const traces = useMemo(() => {
    if (!effectiveCsv || yColumns.length === 0) return [];
    const mode = plotMode === "both" ? "lines+markers" : plotMode === "points" ? "markers" : "lines";
    const rows = effectiveCsv.rows;
    const out: Record<string, unknown>[] = [];
    yColumns.forEach((col, i) => {
      const x: Array<string | number> = [];
      const y: number[] = [];
      for (const row of rows) {
        const xv = row.timestamp;
        const yv = row[col];
        const yNum = typeof yv === "number" ? yv : Number(yv);
        if (xv == null || xv === "" || !Number.isFinite(yNum)) continue;
        x.push(xv as string | number);
        y.push(yNum);
      }
      out.push({
        x,
        y,
        type: "scatter",
        mode,
        name: col,
        line: { width: 2, color: PLOT_COLORS[i % PLOT_COLORS.length] },
        marker: { size: 5, color: PLOT_COLORS[i % PLOT_COLORS.length] },
      });
    });
    if (showFaultOverlays && selectedFaultId && faultData?.series?.length) {
      const series = faultData.series.filter((s) => String(s.metric) === selectedFaultId);
      const x: string[] = [];
      const y: number[] = [];
      for (const s of series) {
        x.push(s.time);
        y.push(s.value > 0 ? 1 : 0);
      }
      out.push({
        x,
        y,
        type: "scatter",
        mode: "lines",
        name: `fault: ${faultOptionLabel(selectedFaultId)}`,
        line: { shape: "hv", width: 1.5, dash: "dot", color: PLOT_COLORS[yColumns.length % PLOT_COLORS.length] },
        yaxis: "y2",
      });
    }
    return out;
  }, [
    effectiveCsv,
    yColumns,
    plotMode,
    selectedFaultId,
    faultData,
    showFaultOverlays,
    faultOptionLabel,
  ]);

  useEffect(() => {
    if (equipmentOptions.length === 0) {
      if (selectedEquipmentId) setSelectedEquipmentId("");
      return;
    }
    if (urlPlotEquipment && equipmentOptions.some((o) => o.id === urlPlotEquipment)) {
      if (selectedEquipmentId !== urlPlotEquipment) setSelectedEquipmentId(urlPlotEquipment);
      return;
    }
    const stillValid = equipmentOptions.some((o) => o.id === selectedEquipmentId);
    if (!stillValid || !selectedEquipmentId) {
      setSelectedEquipmentId(equipmentOptions[0].id);
    }
  }, [selectedEquipmentId, equipmentOptions, urlPlotEquipment]);

  const prevPointSeedEquipmentIdRef = useRef<string>("");

  useEffect(() => {
    if (!selectedEquipmentId) {
      prevPointSeedEquipmentIdRef.current = "";
      return;
    }
    const forEquipment = pointsForEquipment;
    const withHistory = forEquipment.filter((p) => historyPointIds.has(p.id));
    const seed = (withHistory.length > 0 ? withHistory : forEquipment).slice(0, 4).map((p) => p.id);
    const equipmentChanged = prevPointSeedEquipmentIdRef.current !== selectedEquipmentId;
    if (equipmentChanged) {
      prevPointSeedEquipmentIdRef.current = selectedEquipmentId;
      setSelectedPointIds(seed);
      return;
    }
    setSelectedPointIds((prev) => {
      const valid = prev.filter((id) => forEquipment.some((p) => p.id === id));
      if (valid.length !== prev.length) {
        return valid.length > 0 ? valid : seed;
      }
      return prev;
    });
  }, [selectedEquipmentId, pointsForEquipment, historyPointIds]);

  useEffect(() => {
    if (faultIdsForEquipment.length === 0) {
      setSelectedFaultId("");
      return;
    }
    if (urlPlotFault && faultIdsForEquipment.includes(urlPlotFault)) {
      if (selectedFaultId !== urlPlotFault) setSelectedFaultId(urlPlotFault);
      return;
    }
    if (!faultIdsForEquipment.includes(selectedFaultId)) {
      setSelectedFaultId(faultIdsForEquipment[0]);
    }
  }, [faultIdsForEquipment, selectedFaultId, urlPlotFault]);

  const togglePoint = useCallback((id: string) => {
    setSelectedPointIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  if (!selectedSiteId) {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">Plots</h1>
        <div className="flex h-72 flex-col items-center justify-center rounded-2xl border border-border/60 bg-card">
          <p className="text-sm font-medium text-foreground">Select a site to view plots</p>
          <p className="mt-1 text-sm text-muted-foreground">Use the site selector in the top bar.</p>
        </div>
      </div>
    );
  }

  if (ptsLoading || eqLoading) {
    return (
      <div>
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">Plots</h1>
        <Skeleton className="h-[400px] w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Plots</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Plot equipment trends with fault overlays.
          </p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <DateRangeSelect
          preset={preset}
          onPresetChange={setPreset}
          customStart={customStart}
          customEnd={customEnd}
          onCustomStartChange={setCustomStart}
          onCustomEndChange={setCustomEnd}
        />
        <label className="text-sm">Mode:</label>
        <select
          value={plotMode}
          onChange={(e) => setPlotMode(e.target.value as PlotMode)}
          className="h-9 rounded-lg border border-border/60 bg-background px-3 text-sm"
        >
          <option value="lines">Lines</option>
          <option value="points">Points</option>
          <option value="both">Both</option>
        </select>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showFaultOverlays}
            onChange={(e) => setShowFaultOverlays(e.target.checked)}
          />
          Show fault overlays
        </label>
      </div>

      <div className="rounded-lg border border-border/60 bg-card p-4">
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Equipment
            </label>
            <EquipmentCombobox
              options={equipmentOptions}
              selectedId={selectedEquipmentId}
              onChange={(id) => {
                setSelectedEquipmentId(id);
                setSearchParams(
                  (prev) => {
                    const next = new URLSearchParams(prev);
                    if (id) next.set("equipment", id);
                    else next.delete("equipment");
                    next.delete("fault");
                    return next;
                  },
                  { replace: true },
                );
              }}
              disabled={equipmentOptions.length === 0}
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="block text-xs font-medium text-muted-foreground">
                Points (for selected equipment)
              </label>
              {pointsForEquipment.length > 0 && (
                <span className="text-[11px] text-muted-foreground">
                  <span className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500 align-middle" />
                  has history
                </span>
              )}
            </div>
            <div className="h-28 w-full overflow-y-auto rounded-lg border border-border/60 bg-background px-1 py-1 text-sm">
              {pointsForEquipment.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">
                  {selectedEquipmentId ? "No points on this equipment." : "Select equipment to list points."}
                </div>
              ) : (
                pointsForEquipment.map((p) => {
                  const hasHistory = historyPointIds.has(p.id);
                  const checked = selectedPointIds.includes(p.id);
                  return (
                    <label
                      key={p.id}
                      className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-muted/60 ${
                        hasHistory ? "bg-emerald-500/10 text-foreground" : "text-muted-foreground"
                      }`}
                      title={hasHistory ? "Has timeseries history" : "No timeseries history yet"}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => togglePoint(p.id)}
                        className="h-3.5 w-3.5 accent-primary"
                      />
                      {hasHistory && (
                        <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                      )}
                      <span className="truncate">{pointLabel(p)}</span>
                    </label>
                  );
                })
              )}
            </div>
          </div>
          <div>
            <label
              htmlFor="plots-faults-select"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Faults (for selected equipment)
            </label>
            <select
              id="plots-faults-select"
              value={selectedFaultId}
              onChange={(e) => {
                const id = e.target.value;
                setSelectedFaultId(id);
                setSearchParams(
                  (prev) => {
                    const next = new URLSearchParams(prev);
                    if (id) next.set("fault", id);
                    else next.delete("fault");
                    return next;
                  },
                  { replace: true },
                );
              }}
              className="h-9 w-full rounded-lg border border-border/60 bg-background px-3 text-sm"
              disabled={faultIdsForEquipment.length === 0}
              title={
                faultIdsForEquipment.length === 0
                  ? "No fault state rows for this equipment yet. Run FDD or pick another equipment."
                  : undefined
              }
            >
              {faultIdsForEquipment.length === 0 ? (
                <option value="">No faults linked to this equipment</option>
              ) : (
                faultIdsForEquipment.map((faultId) => (
                  <option key={faultId} value={faultId}>
                    {faultOptionLabel(faultId)}
                  </option>
                ))
              )}
            </select>
          </div>
        </div>
        {selectedEquipmentId && faultIdsForEquipment.length === 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Faults listed here come from fault state for the selected equipment. If the list is empty,
            run an FDD job or confirm faults are evaluated for points on this equipment.
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={loadOpenFddCsv}
            disabled={loadingCsv || !selectedEquipmentId || pointIdsForExport.length === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <RefreshCw className="h-4 w-4" />
            {loadingCsv ? "Loading..." : "Load Data from Database"}
          </button>
          <button
            type="button"
            onClick={() => void downloadExcelCsv()}
            disabled={downloadingCsv || !selectedEquipmentId || pointIdsForExport.length === 0}
            className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-background px-4 py-2 text-sm font-medium disabled:opacity-50"
            title="UTF-8 with BOM, wide format: timestamp column plus one column per point (ISO UTC). Excel-ready."
          >
            <Download className="h-4 w-4" />
            {downloadingCsv ? "Downloading..." : "Download CSV"}
          </button>
          <span className="text-xs text-muted-foreground">
            Timestamp is fixed to `timestamp`; fault data is joined automatically when available. If no
            points are checked, all points with history for this equipment are loaded.
          </span>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {effectiveCsv && (
        <div className="rounded-lg border border-border/60 bg-card p-4">
          <div>
            <label
              htmlFor="plots-y-columns-select"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Y columns (multi-select)
            </label>
            <select
              id="plots-y-columns-select"
              multiple
              value={yColumns}
              onChange={(e) => {
                const vals = Array.from(e.target.selectedOptions).map((o) => o.value);
                setYColumns(vals);
              }}
              className="h-28 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
            >
              {effectiveCsv.headers.filter((h) => h !== "timestamp").map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Loaded {effectiveCsv.rows.length.toLocaleString()} rows, {effectiveCsv.headers.length} columns.
          </p>
        </div>
      )}

      <div className="w-full" data-testid="plots-chart-container">
        {traces.length > 0 ? (
          <PlotlyCanvas
            traces={traces}
            title="3MSE FDD Trends"
          />
        ) : (
          <div className="flex h-[50vh] min-h-[360px] items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <ChartLine className="h-4 w-4" />
              Select equipment, pick points with history, then load data to plot.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
