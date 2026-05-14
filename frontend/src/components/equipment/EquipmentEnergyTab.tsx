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
import { EquipmentEnergyProfileCard } from "./EquipmentEnergyProfileCard";
import { OpportunityFormDialog } from "./OpportunityFormDialog";
import { useEquipmentOpportunities } from "@/hooks/use-energy";
import type { DataQuality, EnergyOpportunity } from "@/types/api";

const FAMILY_LABEL: Record<string, string> = {
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

function sumEnabledSavings(opportunities: EnergyOpportunity[]): number {
  let total = 0;
  for (const o of opportunities) {
    if (!o.enabled) continue;
    const v = o.result?.annual_savings_usd;
    if (v != null) total += v;
  }
  return total;
}

function sumCapex(opportunities: EnergyOpportunity[]): number {
  return opportunities.reduce((acc, o) => (o.enabled ? acc + (o.capex_usd ?? 0) : acc), 0);
}

type EquipmentEnergyTabProps = {
  equipmentId: string;
  equipmentName: string;
  equipmentType: string | null;
};

export function EquipmentEnergyTab({
  equipmentId,
  equipmentName,
  equipmentType: _equipmentType,
}: EquipmentEnergyTabProps) {
  const { data: opportunities = [], isLoading } = useEquipmentOpportunities(equipmentId);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const editing = useMemo(
    () => opportunities.find((o) => o.id === editingId) ?? null,
    [opportunities, editingId],
  );

  const totals = useMemo(
    () => ({
      savings: sumEnabledSavings(opportunities),
      capex: sumCapex(opportunities),
      enabled: opportunities.filter((o) => o.enabled).length,
      total: opportunities.length,
    }),
    [opportunities],
  );

  const blendedPayback =
    totals.savings > 0 ? totals.capex / totals.savings : null;

  return (
    <div className="space-y-6">
      <EquipmentEnergyProfileCard equipmentId={equipmentId} />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Cost-benefit headline</CardTitle>
          <p className="text-sm font-normal text-muted-foreground">
            Sums all enabled opportunities for{" "}
            <span className="font-medium">{equipmentName}</span>. Site utility rates feed
            the dollar columns —{" "}
            <Link
              to="/site-configuration#site-energy-rates"
              className="text-primary underline-offset-2 hover:underline"
            >
              edit rates
            </Link>
            .
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="text-xs text-muted-foreground">Total savings</div>
              <div className="text-2xl font-semibold tabular-nums">
                {fmtCurrency(totals.savings)}<span className="text-sm text-muted-foreground">/yr</span>
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
                {fmtYears(blendedPayback)}
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
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
          <div>
            <CardTitle className="text-base">Opportunities</CardTitle>
            <p className="text-sm font-normal text-muted-foreground">
              Click a row to edit. Savings, payback, and data quality come from the
              cached compute — updates immediately on save.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            data-testid="opportunity-add-button"
          >
            <Plus className="h-4 w-4" />
            Add opportunity
          </button>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="px-6 py-4">
              <Skeleton className="h-24 w-full rounded-lg" />
            </div>
          ) : opportunities.length === 0 ? (
            <div
              className="px-6 py-10 text-center text-sm text-muted-foreground"
              data-testid="opportunities-empty"
            >
              No opportunities yet. Click <span className="font-medium">Add opportunity</span> to
              create one.
            </div>
          ) : (
            <Table data-testid="opportunities-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Measure</TableHead>
                  <TableHead>Family</TableHead>
                  <TableHead className="text-right">Savings/yr</TableHead>
                  <TableHead className="text-right">Capex</TableHead>
                  <TableHead className="text-right">Payback</TableHead>
                  <TableHead>Data</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {opportunities.map((o) => (
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
                      <div className="font-medium">{o.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {o.calc_type}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {FAMILY_LABEL[o.measure_family] ?? o.measure_family}
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
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {showAdd && (
        <OpportunityFormDialog
          equipmentId={equipmentId}
          onClose={() => setShowAdd(false)}
        />
      )}
      {editing && (
        <OpportunityFormDialog
          equipmentId={equipmentId}
          opportunity={editing}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}
