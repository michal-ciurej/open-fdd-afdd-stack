import type { DataQuality, EnergyOpportunity, MeasureFamily } from "@/types/api";

/** A single plottable opportunity for the savings-prioritisation bubble chart. */
export interface SavingsBubble {
  id: string;
  name: string;
  equipmentId: string;
  equipmentName: string;
  family: MeasureFamily;
  /** Annual savings (£/yr) - the y-axis. Always finite and > 0 here. */
  savings: number;
  /** Simple payback (years) - the x-axis. Null/instant paybacks clamp to 0. */
  payback: number;
  /** Capex (£) - drives bubble size. Clamped to >= 0. */
  capex: number;
  quality: DataQuality;
}

/**
 * Project enabled opportunities that have a computed savings figure into bubble
 * points. Disabled rows and rows without an `annual_savings_usd` result are
 * dropped - they have nothing to plot. `equipmentName` resolves an equipment id
 * to a display label.
 */
export function toSavingsBubbles(
  opportunities: EnergyOpportunity[],
  equipmentName: (id: string) => string,
): SavingsBubble[] {
  const out: SavingsBubble[] = [];
  for (const o of opportunities) {
    if (!o.enabled) continue;
    const savings = o.result?.annual_savings_usd;
    if (savings == null || !Number.isFinite(savings) || savings <= 0) continue;
    const rawPayback = o.result?.simple_payback_years;
    const payback =
      rawPayback != null && Number.isFinite(rawPayback) && rawPayback > 0
        ? rawPayback
        : 0;
    out.push({
      id: o.id,
      name: o.name,
      equipmentId: o.equipment_id,
      equipmentName: equipmentName(o.equipment_id),
      family: o.measure_family,
      savings,
      payback,
      capex: Math.max(0, o.capex_usd ?? 0),
      quality: o.result?.data_quality ?? "assumed",
    });
  }
  return out;
}

export interface FamilySavings {
  family: MeasureFamily;
  savings: number;
  count: number;
}

/**
 * Sum enabled-opportunity savings per measure family, sorted by savings desc.
 * Families with no enabled savings are omitted.
 */
export function savingsByFamily(opportunities: EnergyOpportunity[]): FamilySavings[] {
  const acc = new Map<MeasureFamily, FamilySavings>();
  for (const o of opportunities) {
    if (!o.enabled) continue;
    const savings = o.result?.annual_savings_usd;
    if (savings == null || !Number.isFinite(savings) || savings <= 0) continue;
    const entry = acc.get(o.measure_family) ?? {
      family: o.measure_family,
      savings: 0,
      count: 0,
    };
    entry.savings += savings;
    entry.count += 1;
    acc.set(o.measure_family, entry);
  }
  return Array.from(acc.values()).sort((a, b) => b.savings - a.savings);
}

/** Opportunities at or below this payback are framed as "quick wins". */
export const QUICK_WIN_PAYBACK_YEARS = 2;
