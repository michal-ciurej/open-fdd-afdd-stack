"use client";

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSiteContext } from "@/contexts/site-context";
import { useEquipment } from "@/hooks/use-sites";
import { useSiteOpportunities } from "@/hooks/use-energy";
import { SavingsPrioritisationChart } from "@/components/energy/SavingsPrioritisationChart";
import { savingsByFamily } from "@/components/energy/savings-prioritisation-utils";
import type { MeasureFamily } from "@/types/api";

const FAMILY_LABEL: Record<MeasureFamily, string> = {
  runtime: "Runtime",
  setpoint_reset: "Setpoint reset",
  airside_thermal: "Airside thermal",
  degradation: "Degradation",
};

function fmtCurrency(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `£${Math.round(value).toLocaleString()}`;
}

function fmtYears(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "0 yr";
  if (value < 0.1) return "< 0.1 yr";
  return `${value.toFixed(1)} yr`;
}

export function EnergyPerformancePage() {
  const { selectedSiteId, selectedSite } = useSiteContext();
  const { data: opportunities = [], isLoading } = useSiteOpportunities(
    selectedSiteId ?? undefined,
  );
  const { data: equipment = [] } = useEquipment(selectedSiteId ?? undefined);

  const equipmentName = useMemo(() => {
    const byId = new Map(equipment.map((e) => [e.id, e.name]));
    return (id: string) => byId.get(id) ?? id.slice(0, 8);
  }, [equipment]);

  const totals = useMemo(() => {
    let savings = 0;
    let capex = 0;
    let enabled = 0;
    for (const o of opportunities) {
      if (!o.enabled) continue;
      enabled += 1;
      capex += o.capex_usd ?? 0;
      const s = o.result?.annual_savings_usd;
      if (s != null) savings += s;
    }
    return {
      savings,
      capex,
      enabled,
      blendedPayback: savings > 0 ? capex / savings : null,
    };
  }, [opportunities]);

  const byFamily = useMemo(() => savingsByFamily(opportunities), [opportunities]);
  const familyMax = useMemo(
    () => Math.max(1, ...byFamily.map((f) => f.savings)),
    [byFamily],
  );

  if (!selectedSiteId) {
    return (
      <div className="flex flex-col">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">Energy Performance</h1>
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Select a site from the sidebar to view its energy performance.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Energy Performance</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Modelled savings for{" "}
            <span className="font-medium">{selectedSite?.name ?? selectedSiteId}</span>,
            prioritised by impact and payback. Edit the backlog on{" "}
            <Link
              to="/energy-engineering"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Opportunities
            </Link>
            .
          </p>
        </div>
      </header>

      {/* Totals */}
      <Card className="mb-6">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Enabled savings</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="text-xs text-muted-foreground">Total savings</div>
              <div className="text-2xl font-semibold tabular-nums">
                {fmtCurrency(totals.savings)}
                <span className="text-sm text-muted-foreground">/yr</span>
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Total capex</div>
              <div className="text-2xl font-semibold tabular-nums">
                {fmtCurrency(totals.capex)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Blended payback</div>
              <div className="text-2xl font-semibold tabular-nums">
                {fmtYears(totals.blendedPayback)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Enabled measures</div>
              <div className="text-2xl font-semibold tabular-nums">{totals.enabled}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Prioritisation bubble chart */}
      <Card className="mb-6">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Prioritisation — impact vs payback</CardTitle>
          <p className="text-sm font-normal text-muted-foreground">
            Top-left = best return. Bubble size shows capex; colour shows how much real data
            backs the estimate.
          </p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-80 w-full rounded-2xl" />
          ) : (
            <SavingsPrioritisationChart
              opportunities={opportunities}
              equipmentName={equipmentName}
            />
          )}
        </CardContent>
      </Card>

      {/* Savings by family */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Savings by measure family</CardTitle>
        </CardHeader>
        <CardContent>
          {byFamily.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              No enabled opportunities with computed savings.
            </p>
          ) : (
            <div className="space-y-3">
              {byFamily.map((f) => (
                <div key={f.family} className="flex items-center gap-3">
                  <div className="w-32 shrink-0 text-sm">{FAMILY_LABEL[f.family]}</div>
                  <div className="h-3 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary/70"
                      style={{ width: `${(f.savings / familyMax) * 100}%` }}
                    />
                  </div>
                  <div className="w-28 shrink-0 text-right font-mono text-sm tabular-nums">
                    {fmtCurrency(f.savings)}/yr
                  </div>
                  <div className="w-16 shrink-0 text-right text-xs text-muted-foreground">
                    {f.count} {f.count === 1 ? "measure" : "measures"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
