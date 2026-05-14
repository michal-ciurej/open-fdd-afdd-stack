"use client";

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Eye } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFaultCountsByEquipment } from "@/hooks/use-faults";
import { isEquipmentObserved, timeAgo } from "@/lib/utils";
import type { Equipment, Site } from "@/types/api";

const DEFAULT_DAYS = 30;

type EquipmentUnderObservationCardProps = {
  /** All equipment in scope (single-site view passes one site's equipment; the
   *  all-sites view passes everything across the portfolio). */
  equipment: Equipment[];
  /** Used to derive the site name column when more than one site is in scope. */
  sites?: Site[];
  /** Filter fault counts by this site when set. */
  siteId?: string;
  /** Lookback window in days for fault counts. Defaults to 30. */
  days?: number;
};

type AggregatedRow = {
  equipment_id: string;
  equipment_name: string;
  equipment_type: string | null;
  site_id: string;
  total_count: number;
  last_ts: string | null;
};

export function EquipmentUnderObservationCard({
  equipment,
  sites,
  siteId,
  days = DEFAULT_DAYS,
}: EquipmentUnderObservationCardProps) {
  const observedEquipment = useMemo(
    () => equipment.filter(isEquipmentObserved),
    [equipment],
  );

  const now = useMemo(() => new Date(), []);
  const start = useMemo(
    () => new Date(now.getTime() - days * 24 * 60 * 60 * 1000),
    [now, days],
  );

  // Only query when there's something to observe — saves a round-trip on the
  // common empty case.
  const enabled = observedEquipment.length > 0;
  const { data: faultCounts, isLoading } = useFaultCountsByEquipment(
    siteId,
    enabled ? start.toISOString() : "",
    enabled ? now.toISOString() : "",
  );

  const aggregated: AggregatedRow[] = useMemo(() => {
    if (!enabled) return [];
    const observedById = new Map(observedEquipment.map((e) => [e.id, e]));
    const acc = new Map<string, AggregatedRow>();

    // Seed a zero-row for every observed equipment so the table shows even
    // when no faults landed in the window.
    for (const eq of observedEquipment) {
      acc.set(eq.id, {
        equipment_id: eq.id,
        equipment_name: eq.name,
        equipment_type: eq.equipment_type,
        site_id: eq.site_id,
        total_count: 0,
        last_ts: null,
      });
    }

    for (const row of faultCounts?.rows ?? []) {
      if (!observedById.has(row.equipment_id)) continue;
      const entry = acc.get(row.equipment_id);
      if (!entry) continue;
      entry.total_count += row.count;
      if (!entry.last_ts || (row.last_ts && row.last_ts > entry.last_ts)) {
        entry.last_ts = row.last_ts;
      }
    }
    return Array.from(acc.values()).sort((a, b) => b.total_count - a.total_count);
  }, [enabled, observedEquipment, faultCounts]);

  const showSiteColumn = !siteId && (sites?.length ?? 0) > 1;
  const siteNameById = useMemo(
    () => new Map((sites ?? []).map((s) => [s.id, s.name])),
    [sites],
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Eye className="h-4 w-4 shrink-0" />
          Equipment under observation
        </CardTitle>
        <p className="text-sm font-normal text-muted-foreground">
          Fault frequency over the last {days} days for equipment flagged via the
          equipment detail page. Click an equipment to drill in.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {observedEquipment.length === 0 ? (
          <div
            className="px-6 py-8 text-center text-sm text-muted-foreground"
            data-testid="observation-empty"
          >
            No equipment marked for observation yet. Open an equipment and click
            <span className="mx-1 font-medium">Mark for observation</span>
            to track its fault frequency here.
          </div>
        ) : isLoading ? (
          <div className="px-6 py-4">
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
        ) : (
          <Table data-testid="observation-table">
            <TableHeader>
              <TableRow>
                <TableHead>Equipment</TableHead>
                <TableHead>Type</TableHead>
                {showSiteColumn && <TableHead>Site</TableHead>}
                <TableHead className="text-right">Faults ({days}d)</TableHead>
                <TableHead className="text-right">Faults / day</TableHead>
                <TableHead className="text-right">Last fault</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {aggregated.map((row) => (
                <TableRow
                  key={row.equipment_id}
                  data-testid={`observation-row-${row.equipment_id}`}
                >
                  <TableCell>
                    <Link
                      to={`/equipment/${row.equipment_id}`}
                      className="font-medium text-primary underline-offset-2 hover:underline"
                    >
                      {row.equipment_name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.equipment_type ?? "—"}
                  </TableCell>
                  {showSiteColumn && (
                    <TableCell className="text-xs text-muted-foreground">
                      {siteNameById.get(row.site_id) ?? row.site_id.slice(0, 8)}
                    </TableCell>
                  )}
                  <TableCell className="text-right font-medium tabular-nums">
                    {row.total_count}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {(row.total_count / days).toFixed(1)}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {row.last_ts ? timeAgo(row.last_ts) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
