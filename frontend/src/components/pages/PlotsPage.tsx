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
  joinFaultSignals,
  parseCsvText,
  pickFaultBucket,
  type ParsedCsv,
} from "@/lib/plots-csv";
import {
  ChartLine,
  ChevronDown,
  Download,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  X,
} from "lucide-react";

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

const PLOT_COLORS_LIGHT = [
  "#1d4ed8",
  "#be185d",
  "#15803d",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#b91c1c",
  "#4d7c0f",
];

const PLOT_COLORS_DARK = [
  "#60a5fa",
  "#f472b6",
  "#4ade80",
  "#fbbf24",
  "#a78bfa",
  "#22d3ee",
  "#f87171",
  "#a3e635",
];

function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState(() =>
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const root = document.documentElement;
    const obs = new MutationObserver(() => {
      setIsDark(root.classList.contains("dark"));
    });
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

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

/**
 * Semantic description of one y-axis, kept style-free so PlotlyCanvas can apply
 * theme colours. Built by the parent from the series' units (see `yAxes`).
 */
type YAxisSpec = {
  title?: string;
  side?: "left" | "right";
  overlaying?: "y";
  range?: [number, number];
  visible?: boolean;
  showgrid?: boolean;
};

function PlotlyCanvas({
  traces,
  title,
  isDark,
  yAxes,
}: {
  traces: Record<string, unknown>[];
  title: string;
  isDark: boolean;
  /** yaxis / yaxis2 / yaxis3 definitions; traces reference these via their `yaxis`. */
  yAxes: Record<string, YAxisSpec>;
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
      const text = isDark ? "rgba(229, 231, 235, 0.82)" : "rgba(17, 24, 39, 0.85)";
      const muted = isDark ? "rgba(229, 231, 235, 0.6)" : "rgba(75, 85, 99, 0.85)";
      const grid = isDark ? "rgba(148, 163, 184, 0.12)" : "rgba(15, 23, 42, 0.08)";
      const axisLine = isDark ? "rgba(148, 163, 184, 0.25)" : "rgba(15, 23, 42, 0.18)";
      const axis = {
        automargin: true,
        gridcolor: grid,
        zerolinecolor: grid,
        linecolor: axisLine,
        tickfont: { color: muted },
        title: { font: { color: muted } },
      };
      // Merge each caller-supplied axis spec with the shared theme styling.
      const yAxisLayout: Record<string, unknown> = {};
      for (const [key, spec] of Object.entries(yAxes)) {
        yAxisLayout[key] = {
          ...axis,
          ...(spec.title !== undefined
            ? { title: { text: spec.title, font: { color: muted } } }
            : {}),
          ...(spec.side ? { side: spec.side } : {}),
          ...(spec.overlaying ? { overlaying: spec.overlaying } : {}),
          ...(spec.range ? { range: spec.range } : {}),
          ...(spec.visible === false ? { visible: false } : {}),
          ...(spec.showgrid === false ? { showgrid: false } : {}),
        };
      }
      Plotly.react(
        ref.current,
        traces,
        {
          title: { text: title, font: { color: text } },
          autosize: true,
          margin: { t: 50, r: 24, b: 48, l: 56 },
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          font: { color: text },
          xaxis: { ...axis, title: { text: "X", font: { color: muted } } },
          ...yAxisLayout,
          legend: { orientation: "h", font: { color: text } },
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
  }, [traces, title, isDark, yAxes]);
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
          {selected ? equipmentLabel(selected) : options.length === 0 ? "No equipment available" : "Select equipment…"}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-1.5 w-full min-w-[18rem] rounded-xl border border-border bg-card shadow-xl">
          <div className="border-b border-border p-2">
            <input
              type="text"
              placeholder="Search equipment by name or type…"
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

/** One plotted time series (a point). `key` is the wide-CSV column = external_id. */
interface ChartSeries {
  key: string;
  pointId: string;
  label: string;
  unit: string | null;
  visible: boolean;
  /** Palette slot assigned at add time and kept for life, so removing another
   *  equipment never recolours this line (and theme switches still recolour it). */
  colorIndex: number;
}

/** Series grouped under the equipment they belong to (one card in the key grid). */
interface EquipmentGroup {
  equipmentId: string;
  equipmentName: string;
  series: ChartSeries[];
}

/**
 * The "y columns" key: a grid of outlined cards, one per equipment. Each card
 * lists its series (click a name to toggle visibility) and an X to remove the
 * whole equipment from the chart. Colours match the plotted lines via colorByKey.
 */
function SeriesKeyGrid({
  groups,
  colorByKey,
  onToggleSeries,
  onRemoveGroup,
}: {
  groups: EquipmentGroup[];
  colorByKey: Record<string, string>;
  onToggleSeries: (equipmentId: string, key: string) => void;
  onRemoveGroup: (equipmentId: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {groups.map((g) => (
        <div
          key={g.equipmentId}
          className="relative rounded-lg border border-border/70 bg-background/40 p-3"
          data-testid={`plots-key-group-${g.equipmentId}`}
        >
          <div className="mb-2 pr-6">
            <span
              className="block truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground"
              title={g.equipmentName}
            >
              {g.equipmentName}
            </span>
          </div>
          <button
            type="button"
            onClick={() => onRemoveGroup(g.equipmentId)}
            aria-label={`Remove ${g.equipmentName} from chart`}
            title={`Remove ${g.equipmentName} from chart`}
            className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <div className="flex flex-col gap-0.5">
            {g.series.map((s) => {
              const color = colorByKey[s.key] ?? "currentColor";
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => onToggleSeries(g.equipmentId, s.key)}
                  title={s.visible ? "Click to hide this series" : "Click to show this series"}
                  aria-pressed={s.visible}
                  className={`flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:bg-muted/60 ${
                    s.visible ? "" : "opacity-40"
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor: s.visible ? color : "transparent",
                      border: `1.5px solid ${color}`,
                    }}
                  />
                  <span className={`truncate ${s.visible ? "" : "line-through"}`}>{s.label}</span>
                  {s.unit ? (
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{s.unit}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Sidebar picker state (browsing) — distinct from what's plotted.
  const [selectedEquipmentId, setSelectedEquipmentId] = useState<string>("");
  const [pickerPointIds, setPickerPointIds] = useState<string[]>([]);
  const [selectedFaultId, setSelectedFaultId] = useState<string>("");
  // What's plotted: series grouped by equipment, accumulated via "Add".
  const [groups, setGroups] = useState<EquipmentGroup[]>([]);
  const [loadingCsv, setLoadingCsv] = useState(false);
  const [downloadingCsv, setDownloadingCsv] = useState(false);
  const [parsedCsv, setParsedCsv] = useState<ParsedCsv | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset the chart + picker when the site changes (equipment/points differ).
  const prevSiteIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevSiteIdRef.current != null && prevSiteIdRef.current !== selectedSiteId) {
      setGroups([]);
      setParsedCsv(null);
      setPickerPointIds([]);
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

  /** Equipment with at least one point attached - nothing to plot otherwise. */
  const equipmentOptions = useMemo(() => {
    return equipment
      .filter((eq) => (pointsByEquipmentId.get(eq.id)?.length ?? 0) > 0)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [equipment, pointsByEquipmentId]);

  /** Points for the browsed equipment, history-backed ones first (then alpha). */
  const pointsForEquipment = useMemo(() => {
    if (!selectedEquipmentId) return [] as Point[];
    const arr = (pointsByEquipmentId.get(selectedEquipmentId) ?? []).slice();
    return arr.sort((a, b) => {
      const ah = historyPointIds.has(a.id) ? 0 : 1;
      const bh = historyPointIds.has(b.id) ? 0 : 1;
      if (ah !== bh) return ah - bh;
      return pointLabel(a).localeCompare(pointLabel(b));
    });
  }, [pointsByEquipmentId, selectedEquipmentId, historyPointIds]);

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

  const isDark = useIsDarkMode();
  const palette = isDark ? PLOT_COLORS_DARK : PLOT_COLORS_LIGHT;

  // Every plotted point id, across all equipment groups (drives the CSV fetch).
  const allPointIds = useMemo(() => {
    const s = new Set<string>();
    for (const g of groups) for (const ser of g.series) s.add(ser.pointId);
    return Array.from(s);
  }, [groups]);
  // Stable key so visibility toggles (which change `groups`) don't refetch data.
  const allPointIdsKey = useMemo(() => [...allPointIds].sort().join("\0"), [allPointIds]);

  // Stable colour per series via its assigned colorIndex, so neither toggling
  // visibility nor removing another equipment recolours it; the key swatch matches
  // the line, and colours still follow the light/dark palette.
  const colorByKey = useMemo(() => {
    const m: Record<string, string> = {};
    for (const g of groups) {
      for (const ser of g.series) {
        m[ser.key] = palette[ser.colorIndex % palette.length];
      }
    }
    return m;
  }, [groups, palette]);

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

  // Auto-load the wide CSV whenever the set of plotted points (or date range)
  // changes. Keyed on allPointIdsKey so a visibility toggle does NOT refetch.
  useEffect(() => {
    if (!selectedSiteId || allPointIds.length === 0) {
      setParsedCsv(null);
      return;
    }
    let cancelled = false;
    setLoadingCsv(true);
    setError(null);
    fetchCsv({
      site_id: selectedSiteId,
      start_date: toDateOnly(start),
      end_date: toDateOnly(end),
      format: "wide",
      point_ids: allPointIds,
    })
      .then((csv) => {
        if (!cancelled) setParsedCsv(parseCsvText(csv));
      })
      .catch((err) => {
        if (!cancelled) {
          setParsedCsv(null);
          setError(err instanceof Error ? err.message : "Failed to load data from Open-FDD.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingCsv(false);
      });
    return () => {
      cancelled = true;
    };
    // allPointIds is intentionally referenced via its stable key; see allPointIdsKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSiteId, allPointIdsKey, start, end]);

  const selectedEquipment = useMemo(
    () => equipmentOptions.find((e) => e.id === selectedEquipmentId) ?? null,
    [equipmentOptions, selectedEquipmentId],
  );

  const downloadExcelCsv = useCallback(async () => {
    if (!selectedSiteId || allPointIds.length === 0) return;
    setDownloadingCsv(true);
    setError(null);
    try {
      const startD = toDateOnly(start);
      const endD = toDateOnly(end);
      await downloadTimeseriesCsv(
        {
          site_id: selectedSiteId,
          start_date: startD,
          end_date: endD,
          format: "wide",
          point_ids: allPointIds,
        },
        `openfdd_plots_${startD}_${endD}.csv`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to download CSV.");
    } finally {
      setDownloadingCsv(false);
    }
  }, [selectedSiteId, start, end, allPointIds]);

  const effectiveCsv = useMemo(() => {
    if (!parsedCsv || !selectedFaultId) return parsedCsv;
    const faults = (faultData?.series ?? []).filter((f) => String(f.metric) === selectedFaultId);
    return joinFaultSignals(parsedCsv, "timestamp", faults, faultBucket);
  }, [parsedCsv, selectedFaultId, faultData, faultBucket]);

  // Only visible series are plotted; toggling a series just hides its line.
  const visibleSeries = useMemo(
    () => groups.flatMap((g) => g.series.filter((s) => s.visible)),
    [groups],
  );

  // Distinct engineering units across the VISIBLE series. Two units → split onto
  // left/right y-axes; one → single labelled axis; three or more → single
  // unitless axis (mixed scales can't share meaningfully).
  const dataUnits = useMemo(() => {
    const s = new Set<string>();
    for (const ser of visibleSeries) if (ser.unit) s.add(ser.unit);
    return Array.from(s);
  }, [visibleSeries]);

  const dualAxis = dataUnits.length === 2;

  // Fault overlay keeps its own 0/1 axis. In dual-unit mode yaxis2 is taken by the
  // second data unit, so the overlay moves to an invisible yaxis3.
  const faultAxisId = dualAxis ? "y3" : "y2";

  const yAxes = useMemo<Record<string, YAxisSpec>>(() => {
    if (dualAxis) {
      const dual: Record<string, YAxisSpec> = {
        yaxis: { title: dataUnits[0] },
        yaxis2: { title: dataUnits[1], overlaying: "y", side: "right" },
        // Fault overlay scale: present so the 0/1 step line has a range, but hidden.
        yaxis3: { overlaying: "y", side: "right", range: [0, 1.1], visible: false },
      };
      return dual;
    }
    const single: Record<string, YAxisSpec> = {
      yaxis: { title: dataUnits.length === 1 ? dataUnits[0] : "Value" },
      yaxis2: {
        title: "Fault 0/1",
        overlaying: "y",
        side: "right",
        range: [0, 1.1],
        showgrid: false,
      },
    };
    return single;
  }, [dualAxis, dataUnits]);

  const traces = useMemo(() => {
    if (!effectiveCsv || visibleSeries.length === 0) return [];
    const mode = plotMode === "both" ? "lines+markers" : plotMode === "points" ? "markers" : "lines";
    const rows = effectiveCsv.rows;
    const out: Record<string, unknown>[] = [];
    for (const ser of visibleSeries) {
      const col = ser.key;
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
      const color = colorByKey[ser.key] ?? palette[0];
      const trace: Record<string, unknown> = {
        x,
        y,
        type: "scatter",
        mode,
        name: ser.label,
        line: { width: isDark ? 2.25 : 2, color },
        marker: { size: 5, color },
      };
      // In dual-unit mode, route each series to the axis matching its unit
      // (second unit → right/y2, everything else → left/y). Single axis otherwise.
      if (dualAxis) trace.yaxis = ser.unit === dataUnits[1] ? "y2" : "y";
      out.push(trace);
    }
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
        line: { shape: "hv", width: 1.5, dash: "dot", color: isDark ? "#f87171" : "#b91c1c" },
        yaxis: faultAxisId,
      });
    }
    return out;
  }, [
    effectiveCsv,
    visibleSeries,
    plotMode,
    colorByKey,
    palette,
    isDark,
    dualAxis,
    dataUnits,
    showFaultOverlays,
    selectedFaultId,
    faultData,
    faultOptionLabel,
    faultAxisId,
  ]);

  // Seed / keep the browsed equipment valid (also honours ?equipment= deep link).
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

  // Picker point selection is per-equipment: clear it when the browsed equipment changes.
  useEffect(() => {
    setPickerPointIds([]);
  }, [selectedEquipmentId]);

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

  const togglePickerPoint = useCallback((id: string) => {
    setPickerPointIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  /** Add the checked picker points as series under their equipment's card. */
  const addSelected = useCallback(() => {
    if (!selectedEquipmentId || pickerPointIds.length === 0) return;
    const eqName = selectedEquipment?.name ?? selectedEquipmentId;
    const byId = new Map(pointsForEquipment.map((p) => [p.id, p]));
    setGroups((prev) => {
      const next = prev.map((g) => ({ ...g, series: [...g.series] }));
      // Next free palette slot: one past the highest in use, so new series get
      // fresh colours and existing ones keep theirs across adds/removes.
      let nextColor = 0;
      for (const g of next) {
        for (const s of g.series) nextColor = Math.max(nextColor, s.colorIndex + 1);
      }
      let group = next.find((g) => g.equipmentId === selectedEquipmentId);
      if (!group) {
        group = { equipmentId: selectedEquipmentId, equipmentName: eqName, series: [] };
        next.push(group);
      }
      const existing = new Set(group.series.map((s) => s.pointId));
      for (const pid of pickerPointIds) {
        if (existing.has(pid)) continue;
        const p = byId.get(pid);
        if (!p || !p.external_id) continue;
        group.series.push({
          key: p.external_id,
          pointId: p.id,
          label: pointLabel(p),
          unit: p.unit ?? null,
          visible: true,
          colorIndex: nextColor,
        });
        nextColor += 1;
      }
      return next;
    });
    setPickerPointIds([]);
  }, [selectedEquipmentId, pickerPointIds, selectedEquipment, pointsForEquipment]);

  const removeGroup = useCallback((equipmentId: string) => {
    setGroups((prev) => prev.filter((g) => g.equipmentId !== equipmentId));
  }, []);

  const toggleSeries = useCallback((equipmentId: string, key: string) => {
    setGroups((prev) =>
      prev.map((g) =>
        g.equipmentId !== equipmentId
          ? g
          : {
              ...g,
              series: g.series.map((s) =>
                s.key === key ? { ...s, visible: !s.visible } : s,
              ),
            },
      ),
    );
  }, []);

  const totalSeries = useMemo(
    () => groups.reduce((n, g) => n + g.series.length, 0),
    [groups],
  );
  const visibleCount = visibleSeries.length;

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

  /**       
   * This bit adds the toggle and title to the charting page. Hiding to maximise vertical space
   * <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Plots</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Add time series from any equipment and compare them on one chart.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setSidebarOpen((v) => !v)}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border/60 bg-background px-3 text-sm font-medium transition-colors hover:bg-muted/40"
          title={sidebarOpen ? "Collapse data selector" : "Expand data selector"}
        >
          {sidebarOpen ? (
            <>
              <PanelLeftClose className="h-4 w-4" /> Hide panel
            </>
          ) : (
            <>
              <PanelLeftOpen className="h-4 w-4" /> Data selector
            </>
          )}
        </button>
      </div>
*/
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      


      

      <div className="flex min-h-0 flex-1 gap-4">
        {sidebarOpen && (
          <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto rounded-lg border border-border/60 bg-card p-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Date range
              </label>
              <DateRangeSelect
                preset={preset}
                onPresetChange={setPreset}
                customStart={customStart}
                customEnd={customEnd}
                onCustomStartChange={setCustomStart}
                onCustomEndChange={setCustomEnd}
              />
            </div>

            <div className="flex items-center gap-3">
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Mode</label>
                <select
                  value={plotMode}
                  onChange={(e) => setPlotMode(e.target.value as PlotMode)}
                  className="h-9 w-full rounded-lg border border-border/60 bg-background px-3 text-sm"
                >
                  <option value="lines">Lines</option>
                  <option value="points">Points</option>
                  <option value="both">Both</option>
                </select>
              </div>
              <label className="mt-5 inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={showFaultOverlays}
                  onChange={(e) => setShowFaultOverlays(e.target.checked)}
                />
                Faults
              </label>
            </div>

            <div className="border-t border-border/60 pt-3">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Equipment</label>
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
                  Points
                </label>
                {pointsForEquipment.length > 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    <span className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500 align-middle" />
                    has history
                  </span>
                )}
              </div>
              <div className="max-h-64 w-full overflow-y-auto rounded-lg border border-border/60 bg-background px-1 py-1 text-sm">
                {pointsForEquipment.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-muted-foreground">
                    {selectedEquipmentId ? "No points on this equipment." : "Select equipment to list points."}
                  </div>
                ) : (
                  pointsForEquipment.map((p) => {
                    const hasHistory = historyPointIds.has(p.id);
                    const checked = pickerPointIds.includes(p.id);
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
                          onChange={() => togglePickerPoint(p.id)}
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
              <button
                type="button"
                onClick={addSelected}
                disabled={pickerPointIds.length === 0}
                className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                Add{pickerPointIds.length > 0 ? ` ${pickerPointIds.length}` : ""} to chart
              </button>
            </div>

            <div className="border-t border-border/60 pt-3">
              <label
                htmlFor="plots-faults-select"
                className="mb-1 block text-xs font-medium text-muted-foreground"
              >
                Fault overlay
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
              <p className="mt-1 text-[11px] text-muted-foreground">
                Overlays the selected fault for the equipment chosen above.
              </p>
            </div>
          </aside>
        )}

        <main className="flex min-w-0 flex-1 flex-col gap-3">
          {error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {groups.length > 0 && (
            <div className="rounded-lg border border-border/60 bg-card p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  Series — {visibleCount}/{totalSeries} shown
                  {loadingCsv ? " · loading…" : ""}
                </span>
                {allPointIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void downloadExcelCsv()}
                    disabled={downloadingCsv}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted/40 disabled:opacity-50"
                    title="Download the plotted points as wide-format CSV (Excel-ready)."
                  >
                    <Download className="h-3.5 w-3.5" />
                    {downloadingCsv ? "Downloading…" : "CSV"}
                  </button>
                )}
              </div>
              <SeriesKeyGrid
                groups={groups}
                colorByKey={colorByKey}
                onToggleSeries={toggleSeries}
                onRemoveGroup={removeGroup}
              />
            </div>
          )}

          <div className="min-h-0 flex-1" data-testid="plots-chart-container">
            {traces.length > 0 ? (
              <PlotlyCanvas
                traces={traces}
                title="Trends and Faults"
                isDark={isDark}
                yAxes={yAxes}
              />
            ) : (
              <div className="flex h-[62vh] min-h-[420px] items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-2 text-center">
                  <ChartLine className="h-4 w-4 shrink-0" />
                  {groups.length === 0
                    ? sidebarOpen
                      ? "Pick an equipment, select points, and click Add to plot."
                      : "Open the data selector to add time series."
                    : loadingCsv
                      ? "Loading data…"
                      : "No data for the selected series in this date range."}
                </span>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
