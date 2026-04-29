import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { useEquipment, usePoints } from "@/hooks/use-sites";
import { useTimeseriesLatest } from "@/hooks/use-timeseries-latest";
import { fetchCsv } from "@/lib/csv";
import { parseCsvText, type ParsedCsv } from "@/lib/plots-csv";
import type { Equipment, Point } from "@/types/api";
import { ChartLine, RefreshCw, Search } from "lucide-react";

type TimeWindow = "24h" | "7d";

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

function presetRange(window: TimeWindow): { start: Date; end: Date } {
  const end = new Date();
  const start = new Date();
  if (window === "24h") start.setHours(start.getHours() - 24);
  else start.setDate(start.getDate() - 7);
  return { start, end };
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
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

interface SearchableListProps<T> {
  label: string;
  placeholder: string;
  items: T[];
  filter: (item: T, q: string) => boolean;
  renderItem: (item: T) => React.ReactNode;
  isSelected: (item: T) => boolean;
  onSelect: (item: T) => void;
  emptyMessage: string;
  disabled?: boolean;
}

function SearchableList<T>({
  label,
  placeholder,
  items,
  filter,
  renderItem,
  isSelected,
  onSelect,
  emptyMessage,
  disabled,
}: SearchableListProps<T>) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    if (!search) return items;
    return items.filter((it) => filter(it, search.toLowerCase()));
  }, [items, search, filter]);

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="h-8 w-full rounded-md border border-border/60 bg-background pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
      <div className="h-32 overflow-y-auto rounded-md border border-border/60 bg-background p-1 text-sm">
        {disabled || items.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">{emptyMessage}</div>
        ) : filtered.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">No matches.</div>
        ) : (
          filtered.map((item, i) => {
            const active = isSelected(item);
            return (
              <button
                key={i}
                type="button"
                onClick={() => onSelect(item)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors hover:bg-muted/60 ${active ? "bg-muted/80 font-medium" : ""}`}
              >
                {renderItem(item)}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

interface DataQueryPlotProps {
  csv: ParsedCsv | null;
  externalIdToLabel: Map<string, string>;
  isLoading: boolean;
  error: string | null;
}

function DataQueryPlot({ csv, externalIdToLabel, isLoading, error }: DataQueryPlotProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  const traces = useMemo(() => {
    if (!csv) return [];
    const yColumns = csv.headers.filter((h) => h !== "timestamp");
    const out: Record<string, unknown>[] = [];
    yColumns.forEach((col, i) => {
      const x: Array<string | number> = [];
      const y: number[] = [];
      for (const row of csv.rows) {
        const xv = row.timestamp;
        const yv = row[col];
        const yNum = typeof yv === "number" ? yv : Number(yv);
        if (xv == null || xv === "" || !Number.isFinite(yNum)) continue;
        x.push(xv as string | number);
        y.push(yNum);
      }
      const display = externalIdToLabel.get(col) ?? col;
      out.push({
        x,
        y,
        type: "scatter",
        mode: "lines",
        name: display,
        line: { width: 2, color: PLOT_COLORS[i % PLOT_COLORS.length] },
      });
    });
    return out;
  }, [csv, externalIdToLabel]);

  useEffect(() => {
    if (!ref.current || traces.length === 0) return;
    let mounted = true;
    void (async () => {
      const Plotly = (await import("plotly.js-dist-min")).default as {
        react: (el: HTMLDivElement, data: unknown[], layout: unknown, config: unknown) => void;
        purge: (el: HTMLDivElement) => void;
      };
      if (!mounted || !ref.current) return;
      Plotly.react(
        ref.current,
        traces,
        {
          autosize: true,
          margin: { t: 16, r: 16, b: 36, l: 48 },
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          xaxis: { automargin: true },
          yaxis: { automargin: true },
          legend: { orientation: "h", y: -0.2 },
          showlegend: true,
        },
        {
          responsive: true,
          displaylogo: false,
          modeBarButtonsToRemove: ["lasso2d", "select2d"],
        },
      );
    })();
    return () => {
      mounted = false;
    };
  }, [traces]);

  if (error) {
    return (
      <div className="flex h-full min-h-[280px] items-center justify-center px-6 text-center text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full min-h-[280px] items-center justify-center text-sm text-muted-foreground">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
        Loading data…
      </div>
    );
  }

  if (traces.length === 0) {
    return (
      <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <ChartLine className="h-6 w-6" />
        Select data to quickly query
      </div>
    );
  }

  return <div ref={ref} className="h-full min-h-[280px] w-full" />;
}

interface DataQueryWidgetProps {
  siteId: string | undefined;
}

export function DataQueryWidget({ siteId }: DataQueryWidgetProps) {
  const { data: equipment = [] } = useEquipment(siteId);
  const { data: points = [] } = usePoints(siteId);
  const { data: latestList = [] } = useTimeseriesLatest(siteId);

  const historyPointIds = useMemo(
    () => new Set(latestList.map((r) => r.point_id)),
    [latestList],
  );

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

  /** Equipment with at least one point that has timeseries history. */
  const equipmentOptions = useMemo(() => {
    return equipment
      .filter((eq) => {
        const eqPoints = pointsByEquipmentId.get(eq.id) ?? [];
        return eqPoints.some((p) => historyPointIds.has(p.id));
      })
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [equipment, pointsByEquipmentId, historyPointIds]);

  const [selectedEquipmentId, setSelectedEquipmentId] = useState<string>("");
  const [selectedPointIds, setSelectedPointIds] = useState<string[]>([]);
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("24h");
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pointsForEquipment = useMemo(() => {
    if (!selectedEquipmentId) return [] as Point[];
    return (pointsByEquipmentId.get(selectedEquipmentId) ?? [])
      .filter((p) => historyPointIds.has(p.id))
      .slice()
      .sort((a, b) => pointLabel(a).localeCompare(pointLabel(b)));
  }, [pointsByEquipmentId, selectedEquipmentId, historyPointIds]);

  /** Reset point selection when equipment changes; reset everything when site changes. */
  useEffect(() => {
    setSelectedPointIds([]);
    setCsv(null);
    setError(null);
  }, [selectedEquipmentId]);

  useEffect(() => {
    setSelectedEquipmentId("");
    setSelectedPointIds([]);
    setCsv(null);
    setError(null);
  }, [siteId]);

  /** Map external_id (the CSV column header) → object_name for plot legend. */
  const externalIdToLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of points) {
      if (p.object_name) m.set(p.external_id, p.object_name);
    }
    return m;
  }, [points]);

  const togglePoint = useCallback((id: string) => {
    setSelectedPointIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const loadData = useCallback(async () => {
    if (!siteId || !selectedEquipmentId || selectedPointIds.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const { start, end } = presetRange(timeWindow);
      const text = await fetchCsv({
        site_id: siteId,
        start_date: toDateOnly(start),
        end_date: toDateOnly(end),
        format: "wide",
        point_ids: selectedPointIds,
      });
      setCsv(parseCsvText(text));
    } catch (err) {
      setCsv(null);
      setError(err instanceof Error ? err.message : "Failed to load data.");
    } finally {
      setLoading(false);
    }
  }, [siteId, selectedEquipmentId, selectedPointIds, timeWindow]);

  const equipmentFilter = useCallback(
    (eq: Equipment, q: string) =>
      eq.name.toLowerCase().includes(q) ||
      (eq.equipment_type?.toLowerCase().includes(q) ?? false) ||
      (eq.description?.toLowerCase().includes(q) ?? false),
    [],
  );

  const pointFilter = useCallback(
    (p: Point, q: string) =>
      pointLabel(p).toLowerCase().includes(q) ||
      (p.description?.toLowerCase().includes(q) ?? false) ||
      (p.brick_type?.toLowerCase().includes(q) ?? false),
    [],
  );

  const canLoad = !!selectedEquipmentId && selectedPointIds.length > 0 && !loading;

  return (
    <Card tone="glass" className="mt-6 overflow-hidden">
      <div className="flex flex-col gap-4 p-4 lg:flex-row">
        <div className="flex w-full flex-col gap-3 lg:w-72 lg:shrink-0">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Data Query</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Pick equipment, points, and a window — then load.
            </p>
          </div>

          <SearchableList<Equipment>
            label="Equipment"
            placeholder="Search equipment…"
            items={equipmentOptions}
            filter={equipmentFilter}
            isSelected={(eq) => eq.id === selectedEquipmentId}
            onSelect={(eq) => setSelectedEquipmentId(eq.id)}
            emptyMessage={
              !siteId
                ? "Select a site to begin."
                : "No equipment with timeseries history."
            }
            renderItem={(eq) => <span className="truncate">{equipmentLabel(eq)}</span>}
            disabled={!siteId || equipmentOptions.length === 0}
          />

          <SearchableList<Point>
            label="Histories"
            placeholder="Search histories…"
            items={pointsForEquipment}
            filter={pointFilter}
            isSelected={(p) => selectedPointIds.includes(p.id)}
            onSelect={(p) => togglePoint(p.id)}
            emptyMessage={
              selectedEquipmentId
                ? "No histories on this equipment."
                : "Select equipment to list histories."
            }
            renderItem={(p) => (
              <>
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${selectedPointIds.includes(p.id) ? "bg-primary" : "bg-muted-foreground/40"}`}
                  aria-hidden
                />
                <span className="truncate">{pointLabel(p)}</span>
              </>
            )}
            disabled={!selectedEquipmentId || pointsForEquipment.length === 0}
          />

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Time window</label>
            <div className="inline-flex h-8 items-center gap-1 rounded-md bg-muted/70 p-1">
              {(["24h", "7d"] as TimeWindow[]).map((w) => (
                <button
                  key={w}
                  type="button"
                  aria-pressed={timeWindow === w}
                  onClick={() => setTimeWindow(w)}
                  className={`flex-1 rounded px-3 py-1 text-xs font-medium transition-colors ${
                    timeWindow === w
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {w === "24h" ? "24 h" : "7 d"}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={() => void loadData()}
            disabled={!canLoad}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50"
          >
            {loading ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" />
                Loading…
              </>
            ) : (
              "Load"
            )}
          </button>
        </div>

        <div className="min-h-[320px] flex-1 rounded-lg border border-border/60 bg-card/40">
          <DataQueryPlot
            csv={csv}
            externalIdToLabel={externalIdToLabel}
            isLoading={loading}
            error={error}
          />
        </div>
      </div>
    </Card>
  );
}
