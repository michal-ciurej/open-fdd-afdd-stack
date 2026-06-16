import { describe, it, expect } from "vitest";
import {
  savingsByFamily,
  toSavingsBubbles,
} from "./savings-prioritisation-utils";
import type {
  EnergyOpportunity,
  EnergyOpportunityResult,
  MeasureFamily,
} from "@/types/api";

function result(
  partial: Partial<EnergyOpportunityResult>,
): EnergyOpportunityResult {
  return {
    baseline_annual_cost_usd: null,
    projected_annual_cost_usd: null,
    annual_savings_usd: null,
    annual_kwh_saved: null,
    annual_therms_saved: null,
    peak_kw_reduced: null,
    simple_payback_years: null,
    npv_5yr_usd: null,
    fault_hours_observed: null,
    data_quality: "assumed",
    missing_inputs: [],
    notes: null,
    computed_at: null,
    ...partial,
  };
}

function opp(partial: Partial<EnergyOpportunity>): EnergyOpportunity {
  return {
    id: "o1",
    equipment_id: "e1",
    external_id: "x1",
    name: "Measure",
    description: null,
    measure_family: "runtime" as MeasureFamily,
    calc_type: "runtime_reduction",
    fdd_rule_id: null,
    delta_params: {},
    capex_usd: 0,
    enabled: true,
    created_at: "",
    updated_at: "",
    result: null,
    ...partial,
  };
}

describe("toSavingsBubbles", () => {
  const name = (id: string) => (id === "e1" ? "AHU-1" : id);

  it("drops disabled opportunities", () => {
    const rows = toSavingsBubbles(
      [opp({ enabled: false, result: result({ annual_savings_usd: 1000 }) })],
      name,
    );
    expect(rows).toHaveLength(0);
  });

  it("drops opportunities with no/zero savings", () => {
    const rows = toSavingsBubbles(
      [
        opp({ id: "a", result: null }),
        opp({ id: "b", result: result({ annual_savings_usd: 0 }) }),
        opp({ id: "c", result: result({ annual_savings_usd: -5 }) }),
      ],
      name,
    );
    expect(rows).toHaveLength(0);
  });

  it("clamps null/negative payback to 0 (treated as a quick win)", () => {
    const [row] = toSavingsBubbles(
      [opp({ result: result({ annual_savings_usd: 500, simple_payback_years: null }) })],
      name,
    );
    expect(row.payback).toBe(0);
  });

  it("resolves equipment name and carries savings/capex/quality", () => {
    const [row] = toSavingsBubbles(
      [
        opp({
          capex_usd: 1200,
          result: result({
            annual_savings_usd: 800,
            simple_payback_years: 1.5,
            data_quality: "observed",
          }),
        }),
      ],
      name,
    );
    expect(row.equipmentName).toBe("AHU-1");
    expect(row.savings).toBe(800);
    expect(row.payback).toBe(1.5);
    expect(row.capex).toBe(1200);
    expect(row.quality).toBe("observed");
  });
});

describe("savingsByFamily", () => {
  it("sums enabled savings per family, sorted desc", () => {
    const out = savingsByFamily([
      opp({ id: "a", measure_family: "runtime", result: result({ annual_savings_usd: 100 }) }),
      opp({ id: "b", measure_family: "runtime", result: result({ annual_savings_usd: 50 }) }),
      opp({ id: "c", measure_family: "degradation", result: result({ annual_savings_usd: 400 }) }),
      opp({ id: "d", measure_family: "setpoint_reset", enabled: false, result: result({ annual_savings_usd: 999 }) }),
    ]);
    expect(out).toEqual([
      { family: "degradation", savings: 400, count: 1 },
      { family: "runtime", savings: 150, count: 2 },
    ]);
  });
});
