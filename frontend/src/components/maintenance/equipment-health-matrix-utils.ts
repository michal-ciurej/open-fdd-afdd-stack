import type { MaintenanceEquipmentRow } from "@/types/api";

/** Total faults across the observation window for one equipment row. */
export function totalFaults(row: MaintenanceEquipmentRow): number {
  return row.fault_histogram.reduce((a, b) => a + b, 0);
}

/** Worst-offending equipment first; ties keep input order (stable). */
export function sortByFaultLoad(
  rows: MaintenanceEquipmentRow[],
): MaintenanceEquipmentRow[] {
  return [...rows].sort((a, b) => totalFaults(b) - totalFaults(a));
}

/** Largest single-day fault count across all rows (matrix colour scale). */
export function matrixMax(rows: MaintenanceEquipmentRow[]): number {
  let max = 0;
  for (const r of rows) {
    for (const v of r.fault_histogram) if (v > max) max = v;
  }
  return max;
}

/**
 * Day index of the maintenance marker within `histogram_days`, or -1 when the
 * equipment has never been maintained / the date falls outside the window.
 * Mirrors the cutoff logic in the per-row FaultSparkline.
 */
export function maintenanceCutoffIndex(
  maintainedTs: string | null,
  days: string[],
): number {
  if (!maintainedTs) return -1;
  return days.indexOf(maintainedTs.slice(0, 10));
}

/**
 * Discrete heat level 0..4 for a cell, scaled to the matrix max. 0 faults
 * always maps to 0; any positive count maps to at least 1.
 */
export function cellLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}
