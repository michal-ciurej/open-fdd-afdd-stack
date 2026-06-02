import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from "@/components/ui/chart";
import type { ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { usePoints } from "@/hooks/use-sites";
import { useTimeseriesLatest } from "@/hooks/use-timeseries-latest";
import { fetchCsv, parseLongCsv } from "@/lib/csv";
import type { Point } from "@/types/api";

const COLORS = [
  "hsl(215, 60%, 42%)",
  "hsl(338, 65%, 48%)",
  "hsl(142, 71%, 35%)",
  "hsl(38, 92%, 50%)",
  "hsl(262, 52%, 50%)",
  "hsl(190, 70%, 40%)",
  "hsl(330, 55%, 45%)",
  "hsl(60, 65%, 38%)",
];

/** Cap traces so a busy equipment doesn't overload the chart / colour palette. */
const MAX_SERIES = 8;

/** One {timestamp, value} sample for a single point. */
interface PointSample {
  timestamp: number;
  value: number;
}

function pointLabel(p: Point): string {
  return p.object_name ?? p.external_id;
}

/**
 * Fetch a single point's timeseries over the window. Each point is requested on
 * its own so a failure on one series never blocks the others on the same card.
 * A 404 (no rows for this point) is treated as an empty series, not a failure.
 */
async function fetchPointSeries(
  siteId: string,
  point: Point,
  startDate: string,
  endDate: string,
): Promise<PointSample[]> {
  console.debug(
    "[EngineerReport] fetch series →",
    point.external_id,
    point.id,
    `${startDate.slice(0, 10)}…${endDate.slice(0, 10)}`,
  );
  try {
    const csv = await fetchCsv({
      site_id: siteId,
      point_ids: [point.id],
      start_date: startDate.slice(0, 10),
      end_date: endDate.slice(0, 10),
      format: "long",
    });
    // Single point per request, so every row belongs to this point — read the
    // value column directly and ignore the (UUID-keyed) point_key column.
    const samples = parseLongCsv(csv)
      .map((r) => ({ timestamp: r.timestamp, value: r.value }))
      .sort((a, b) => a.timestamp - b.timestamp);
    console.debug(
      "[EngineerReport] series ok ←",
      point.external_id,
      `${samples.length} samples`,
    );
    return samples;
  } catch (e) {
    if (e instanceof Error && e.message.includes("404")) {
      console.debug("[EngineerReport] series empty (404) ←", point.external_id);
      return [];
    }
    console.error("[EngineerReport] series failed ←", point.external_id, e);
    throw e;
  }
}

interface EngineerReportTimeseriesChartProps {
  /** Site the equipment belongs to — scopes points & history queries. */
  siteId: string;
  equipmentId: string;
  /** Look-back window in days (matches the report time toggle). */
  windowDays: number;
  height?: number;
}

/**
 * Full-width timeseries chart that auto-loads every history-backed point on a
 * single piece of equipment over the report window. Each point is loaded as an
 * independent query so a single failing series degrades gracefully rather than
 * blanking the whole chart. Used by the Engineer Planner report card.
 */
export function EngineerReportTimeseriesChart({
  siteId,
  equipmentId,
  windowDays,
  height = 240,
}: EngineerReportTimeseriesChartProps) {
  const { data: points = [] } = usePoints(siteId);
  const { data: latestList = [] } = useTimeseriesLatest(siteId);

  const historyPointIds = useMemo(
    () => new Set(latestList.map((r) => r.point_id)),
    [latestList],
  );

  /** History-backed points on this equipment, capped to MAX_SERIES. */
  const equipmentPoints = useMemo(() => {
    const selected = points
      .filter((p) => p.equipment_id === equipmentId && historyPointIds.has(p.id))
      .slice()
      .sort((a, b) => pointLabel(a).localeCompare(pointLabel(b)))
      .slice(0, MAX_SERIES);
    console.debug(
      "[EngineerReport] equipment",
      equipmentId,
      `→ ${selected.length} history-backed point(s)`,
      selected.map((p) => p.external_id),
    );
    return selected;
  }, [points, equipmentId, historyPointIds]);

  const { start, end } = useMemo(() => {
    const e = new Date();
    const s = new Date();
    s.setDate(s.getDate() - windowDays);
    return { start: s.toISOString(), end: e.toISOString() };
  }, [windowDays]);

  // One query per point — failures are isolated to that series.
  const results = useQueries({
    queries: equipmentPoints.map((p) => ({
      queryKey: [
        "engineer-report-series",
        siteId,
        p.id,
        start.slice(0, 10),
        end.slice(0, 10),
      ],
      queryFn: () => fetchPointSeries(siteId, p, start, end),
      staleTime: 2 * 60 * 1000,
      retry: 1,
      enabled: !!siteId,
    })),
  });

  const anySettled = results.some((r) => r.isSuccess || r.isError);
  const allLoading =
    equipmentPoints.length > 0 && results.every((r) => r.isLoading);

  /** Points whose series loaded (even if empty) and their colour assignment. */
  const succeeded = useMemo(
    () =>
      equipmentPoints
        .map((point, i) => ({ point, result: results[i] }))
        .filter((s) => s.result?.isSuccess),
    [equipmentPoints, results],
  );

  const failedLabels = useMemo(
    () =>
      equipmentPoints
        .filter((_, i) => results[i]?.isError)
        .map((p) => pointLabel(p)),
    [equipmentPoints, results],
  );

  const config: ChartConfig = useMemo(() => {
    const c: ChartConfig = {};
    succeeded.forEach(({ point }, i) => {
      c[point.id] = {
        label: point.object_name ?? point.external_id,
        color: COLORS[i % COLORS.length],
        unit: point.unit ?? undefined,
      };
    });
    return c;
  }, [succeeded]);

  const seriesKeys = useMemo(
    () => succeeded.map((s) => s.point.id),
    [succeeded],
  );

  /** Merge each successful series into Recharts rows keyed by point id. */
  const chartData = useMemo(() => {
    const byTs = new Map<number, Record<string, number>>();
    for (const { point, result } of succeeded) {
      for (const sample of (result.data ?? []) as PointSample[]) {
        if (!Number.isFinite(sample.timestamp)) continue;
        const row = byTs.get(sample.timestamp) ?? {};
        row[point.id] = sample.value;
        byTs.set(sample.timestamp, row);
      }
    }
    const rows = Array.from(byTs.entries())
      .sort(([a], [b]) => a - b)
      .map(([timestamp, rest]) => ({ timestamp, ...rest }));
    console.debug(
      "[EngineerReport] merged chart for",
      equipmentId,
      `→ ${rows.length} rows, ${seriesKeys.length} series` +
        (failedLabels.length ? `, ${failedLabels.length} failed` : ""),
    );
    return rows;
  }, [succeeded, seriesKeys.length, failedLabels.length, equipmentId]);

  const timeFormat = (ts: number) =>
    new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
  const tooltipFormat = (ts: number) =>
    new Date(ts).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const placeholderStyle = { height };

  if (equipmentPoints.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-border/60 bg-muted/30"
        style={placeholderStyle}
      >
        <p className="text-sm text-muted-foreground">
          No timeseries history associated with this equipment.
        </p>
      </div>
    );
  }

  if (allLoading || !anySettled) {
    return <Skeleton className="w-full rounded-xl" style={placeholderStyle} />;
  }

  if (chartData.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-1 rounded-xl border border-border/60 bg-muted/30"
        style={placeholderStyle}
      >
        <p className="text-sm text-muted-foreground">
          No data in the last {windowDays} days.
        </p>
        {failedLabels.length > 0 && (
          <p className="text-xs text-destructive">
            {failedLabels.length} series failed to load.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <ChartContainer
        config={config}
        className="rounded-xl border border-border/60 bg-card p-4"
      >
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={chartData}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="hsl(220 13% 90% / 0.5)"
              vertical={false}
            />
            <XAxis
              dataKey="timestamp"
              type="number"
              domain={["dataMin", "dataMax"]}
              scale="time"
              tickFormatter={timeFormat}
              tick={{ fontSize: 12, fill: "hsl(220 8% 46%)" }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fontSize: 12, fill: "hsl(220 8% 46%)" }}
              tickLine={false}
              axisLine={false}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent config={config} formatTime={tooltipFormat} />
              }
            />
            <ChartLegend content={<ChartLegendContent config={config} />} />
            {seriesKeys.map((key) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                stroke={config[key]?.color}
                strokeWidth={1.5}
                dot={false}
                connectNulls
                activeDot={{ r: 3.5, strokeWidth: 0 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartContainer>
      {failedLabels.length > 0 && (
        <p className="px-1 text-xs text-destructive">
          {failedLabels.length} series failed to load: {failedLabels.join(", ")}
        </p>
      )}
    </div>
  );
}
