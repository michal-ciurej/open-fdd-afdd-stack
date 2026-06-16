import { describe, it, expect } from "vitest";
import {
  cellLevel,
  maintenanceCutoffIndex,
  matrixMax,
  sortByFaultLoad,
  totalFaults,
} from "./equipment-health-matrix-utils";
import type { MaintenanceEquipmentRow } from "@/types/api";

function row(partial: Partial<MaintenanceEquipmentRow>): MaintenanceEquipmentRow {
  return {
    equipment_id: "e1",
    site_id: "s1",
    name: "AHU-1",
    equipment_type: "Air_Handling_Unit",
    scheduled: false,
    last_scheduled_ts: null,
    last_maintained_ts: null,
    last_cancelled_ts: null,
    fault_histogram: [],
    histogram_days: [],
    ...partial,
  };
}

describe("totalFaults / sortByFaultLoad", () => {
  it("sums the histogram", () => {
    expect(totalFaults(row({ fault_histogram: [1, 0, 3] }))).toBe(4);
  });

  it("orders worst-offenders first", () => {
    const rows = [
      row({ equipment_id: "a", fault_histogram: [1, 1] }),
      row({ equipment_id: "b", fault_histogram: [5, 5] }),
      row({ equipment_id: "c", fault_histogram: [0, 0] }),
    ];
    expect(sortByFaultLoad(rows).map((r) => r.equipment_id)).toEqual(["b", "a", "c"]);
  });
});

describe("matrixMax", () => {
  it("returns the largest single-day count across rows", () => {
    expect(
      matrixMax([row({ fault_histogram: [1, 2] }), row({ fault_histogram: [0, 7] })]),
    ).toBe(7);
  });

  it("returns 0 for empty input", () => {
    expect(matrixMax([])).toBe(0);
  });
});

describe("maintenanceCutoffIndex", () => {
  const days = ["2026-06-01", "2026-06-02", "2026-06-03"];

  it("returns -1 when never maintained", () => {
    expect(maintenanceCutoffIndex(null, days)).toBe(-1);
  });

  it("matches by date prefix ignoring time", () => {
    expect(maintenanceCutoffIndex("2026-06-02T14:30:00Z", days)).toBe(1);
  });

  it("returns -1 when the date is outside the window", () => {
    expect(maintenanceCutoffIndex("2026-05-30", days)).toBe(-1);
  });
});

describe("cellLevel", () => {
  it("maps zero to level 0", () => {
    expect(cellLevel(0, 10)).toBe(0);
  });

  it("maps any positive value to at least 1", () => {
    expect(cellLevel(1, 100)).toBe(1);
  });

  it("buckets by ratio to the max", () => {
    expect(cellLevel(3, 10)).toBe(2); // 0.30
    expect(cellLevel(6, 10)).toBe(3); // 0.60
    expect(cellLevel(9, 10)).toBe(4); // 0.90
  });

  it("is safe when max is 0", () => {
    expect(cellLevel(5, 0)).toBe(0);
  });
});
