"use client";

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Zap, ZapOff } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSiteContext } from "@/contexts/site-context";
import { useEquipment } from "@/hooks/use-sites";
import { useSiteOpportunities } from "@/hooks/use-energy";
import { OpportunityFormDialog } from "@/components/equipment/OpportunityFormDialog";
import type {
  DataQuality,
  EnergyOpportunity,
  MeasureFamily,
} from "@/types/api";

const FAMILY_LABEL: Record<MeasureFamily, string> = {
  runtime: "Runtime",
  setpoint_reset: "Setpoint reset",
  airside_thermal: "Airside thermal",
  degradation: "Degradation",
};

const QUALITY_VARIANT: Record<DataQuality, "success" | "secondary" | "outline"> = {
  observed: "success",
  partial: "secondary",
  assumed: "outline",
};

type EnabledFilter = "all" | "enabled" | "disabled";
type SortKey = "savings_desc" | "savings_asc" | "payback_asc" | "name_asc";

const inputBase =
  "h-9 rounded-lg border border-border/60 bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

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

function sortOpportunities(rows: EnergyOpportunity[], key: SortKey): EnergyOpportunity[] {
  const out = [...rows];
  out.sort((a, b) => {
    switch (key) {
      case "savings_desc": {
        const av = a.result?.annual_savings_usd ?? -Infinity;
        const bv = b.result?.annual_savings_usd ?? -Infinity;
        return bv - av;
      }
      case "savings_asc": {
        const av = a.result?.annual_savings_usd ?? Infinity;
        const bv = b.result?.annual_savings_usd ?? Infinity;
        return av - bv;
      }
      case "payback_asc": {
        const av = a.result?.simple_payback_years ?? Infinity;
        const bv = b.result?.simple_payback_years ?? Infinity;
        return av - bv;
      }
      case "name_asc":
        return a.name.localeCompare(b.name);
    }
  });
  return out;
}

export function EnergyOpportunitiesPage() {
  const { selectedSiteId, selectedSite } = useSiteContext();
  const { data: opportunities = [], isLoading } = useSiteOpportunities(
    selectedSiteId ?? undefined,
  );
  const { data: equipment = [] } = useEquipment(selectedSiteId ?? undefined);

  const equipmentById = useMemo(
    () => new Map(equipment.map((e) => [e.id, e])),
    [equipment],
  );

  const equipmentTypes = useMemo(() => {
    const set = new Set<string>();
    for (const o of opportunities) {
      const t = equipmentById.get(o.equipment_id)?.equipment_type;
      if (t) set.add(t);
    }
    return Array.from(set).sort();
  }, [opportunities, equipmentById]);

  const [equipmentTypeFilter, setEquipmentTypeFilter] = useState<string>("all");
  const [familyFilter, setFamilyFilter] = useState<string>("all");
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("savings_desc");
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = useMemo(
    () => opportunities.find((o) => o.id === editingId) ?? null,
    [opportunities, editingId],
  );

  const filtered = useMemo(() => {
    const rows = opportunities.filter((o) => {
      if (familyFilter !== "all" && o.measure_family !== familyFilter) return false;
      if (enabledFilter === "enabled" && !o.enabled) return false;
      if (enabledFilter === "disabled" && o.enabled) return false;
      if (equipmentTypeFilter !== "all") {
        const t = equipmentById.get(o.equipment_id)?.equipment_type;
        if (t !== equipmentTypeFilter) return false;
      }
      return true;
    });
    return sortOpportunities(rows, sortKey);
  }, [opportunities, equipmentById, equipmentTypeFilter, familyFilter, enabledFilter, sortKey]);

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
      total: opportunities.length,
      blendedPayback: savings > 0 ? capex / savings : null,
    };
  }, [opportunities]);

  if (!selectedSiteId) {
    return (
      <div className="flex flex-col">
        <header className="mb-6 flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Energy Analysis</h1>
        </header>
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Select a site from the sidebar to view its energy opportunities.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Energy Analysis</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cross-equipment opportunities for{" "}
            <span className="font-medium">{selectedSite?.name ?? selectedSiteId}</span>. Click a
            row to open it on the equipment page.
          </p>
        </div>
        <Link
          to="/site-configuration#site-energy-rates"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          Edit site rates →
        </Link>
      </header>

      <Card className="mb-6">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Site totals</CardTitle>
          <p className="text-sm font-normal text-muted-foreground">
            Sums every <strong>enabled</strong> opportunity on this site. Disabled rows (including
            auto-seeded suggestions) are excluded.
          </p>
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
              <div className="text-xs text-muted-foreground">Opportunities</div>
              <div className="text-2xl font-semibold tabular-nums">
                {totals.enabled}
                <span className="text-sm text-muted-foreground"> / {totals.total}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Opportunities</CardTitle>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Equipment type
              </label>
              <select
                value={equipmentTypeFilter}
                onChange={(e) => setEquipmentTypeFilter(e.target.value)}
                className={inputBase}
                data-testid="opportunities-filter-equipment-type"
              >
                <option value="all">All</option>
                {equipmentTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Family
              </label>
              <select
                value={familyFilter}
                onChange={(e) => setFamilyFilter(e.target.value)}
                className={inputBase}
                data-testid="opportunities-filter-family"
              >
                <option value="all">All</option>
                {Object.entries(FAMILY_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Status
              </label>
              <select
                value={enabledFilter}
                onChange={(e) => setEnabledFilter(e.target.value as EnabledFilter)}
                className={inputBase}
                data-testid="opportunities-filter-enabled"
              >
                <option value="all">All</option>
                <option value="enabled">Enabled only</option>
                <option value="disabled">Disabled / suggested</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Sort
              </label>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className={inputBase}
                data-testid="opportunities-sort"
              >
                <option value="savings_desc">Savings ↓</option>
                <option value="savings_asc">Savings ↑</option>
                <option value="payback_asc">Payback ↑</option>
                <option value="name_asc">Name (A→Z)</option>
              </select>
            </div>
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="ml-auto inline-flex items-center gap-2 self-end rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              data-testid="opportunities-add-button"
            >
              <Plus className="h-4 w-4" />
              New opportunity
            </button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="px-6 py-4">
              <Skeleton className="h-32 w-full rounded-lg" />
            </div>
          ) : filtered.length === 0 ? (
            <div
              className="px-6 py-10 text-center text-sm text-muted-foreground"
              data-testid="opportunities-empty"
            >
              {opportunities.length === 0
                ? "No opportunities yet. Click New opportunity to create one — or let the FDD loop auto-seed them when rules fire."
                : "No opportunities match the current filters."}
            </div>
          ) : (
            <Table data-testid="opportunities-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Equipment</TableHead>
                  <TableHead>Measure</TableHead>
                  <TableHead>Family</TableHead>
                  <TableHead className="text-right">Savings/yr</TableHead>
                  <TableHead className="text-right">Capex</TableHead>
                  <TableHead className="text-right">Payback</TableHead>
                  <TableHead>Data</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((o) => {
                  const eq = equipmentById.get(o.equipment_id);
                  return (
                    <TableRow
                      key={o.id}
                      className="cursor-pointer"
                      onClick={() => setEditingId(o.id)}
                      data-testid={`opportunity-row-${o.id}`}
                    >
                      <TableCell>
                        {o.enabled ? (
                          <Zap className="h-4 w-4 text-primary" />
                        ) : (
                          <ZapOff className="h-4 w-4 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell>
                        <Link
                          to={`/equipment/${o.equipment_id}?tab=energy`}
                          onClick={(e) => e.stopPropagation()}
                          className="font-medium text-primary underline-offset-2 hover:underline"
                        >
                          {eq?.name ?? o.equipment_id.slice(0, 8)}
                        </Link>
                        {eq?.equipment_type && (
                          <div className="font-mono text-xs text-muted-foreground">
                            {eq.equipment_type}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{o.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {o.calc_type}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {FAMILY_LABEL[o.measure_family]}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {fmtCurrency(o.result?.annual_savings_usd ?? null)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {fmtCurrency(o.capex_usd)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {fmtYears(o.result?.simple_payback_years ?? null)}
                      </TableCell>
                      <TableCell>
                        {o.result ? (
                          <Badge variant={QUALITY_VARIANT[o.result.data_quality]}>
                            {o.result.data_quality}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {showAdd && (
        <OpportunityFormDialog
          siteId={selectedSiteId}
          onClose={() => setShowAdd(false)}
        />
      )}
      {editing && (
        <OpportunityFormDialog
          equipmentId={editing.equipment_id}
          opportunity={editing}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}
