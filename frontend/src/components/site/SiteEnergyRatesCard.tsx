"use client";

import { useEffect, useState } from "react";
import { Zap, Save } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSiteContext } from "@/contexts/site-context";
import {
  useSiteEnergyRates,
  useUpdateSiteEnergyRates,
} from "@/hooks/use-energy";

const field =
  "h-9 w-32 rounded-lg border border-border/60 bg-background px-3 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring";

type RateForm = {
  electric_rate_per_kwh: string;
  demand_charge_per_kw: string;
  therm_rate_usd: string;
  currency: string;
};

const EMPTY_FORM: RateForm = {
  electric_rate_per_kwh: "",
  demand_charge_per_kw: "",
  therm_rate_usd: "",
  currency: "USD",
};

function toForm(rates: {
  electric_rate_per_kwh: number;
  demand_charge_per_kw: number;
  therm_rate_usd: number;
  currency: string;
}): RateForm {
  return {
    electric_rate_per_kwh: String(rates.electric_rate_per_kwh),
    demand_charge_per_kw: String(rates.demand_charge_per_kw),
    therm_rate_usd: String(rates.therm_rate_usd),
    currency: rates.currency,
  };
}

type SiteEnergyRatesCardProps = {
  className?: string;
};

export function SiteEnergyRatesCard({ className }: SiteEnergyRatesCardProps) {
  const { selectedSiteId, selectedSite } = useSiteContext();
  const { data: rates, isLoading } = useSiteEnergyRates(selectedSiteId ?? undefined);
  const updateMutation = useUpdateSiteEnergyRates(selectedSiteId ?? undefined);

  const [form, setForm] = useState<RateForm>(EMPTY_FORM);

  useEffect(() => {
    setForm(rates ? toForm(rates) : EMPTY_FORM);
  }, [rates, selectedSiteId]);

  const dirty =
    rates != null &&
    (form.electric_rate_per_kwh !== String(rates.electric_rate_per_kwh) ||
      form.demand_charge_per_kw !== String(rates.demand_charge_per_kw) ||
      form.therm_rate_usd !== String(rates.therm_rate_usd) ||
      form.currency !== rates.currency);

  function handleSave() {
    if (!selectedSiteId) return;
    const electric = Number(form.electric_rate_per_kwh);
    const demand = Number(form.demand_charge_per_kw);
    const therm = Number(form.therm_rate_usd);
    if (!Number.isFinite(electric) || electric < 0) return;
    if (!Number.isFinite(demand) || demand < 0) return;
    if (!Number.isFinite(therm) || therm < 0) return;
    updateMutation.mutate({
      electric_rate_per_kwh: electric,
      demand_charge_per_kw: demand,
      therm_rate_usd: therm,
      currency: form.currency.trim() || "USD",
    });
  }

  return (
    <Card id="site-energy-rates" className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
          <Zap className="h-5 w-5 shrink-0" />
          Energy rates
        </CardTitle>
        <p className="text-sm font-normal text-muted-foreground">
          Utility rates for the active site. Used by the energy opportunity calculator to
          convert kWh and therms into dollars. One row per site; changes take effect on the
          next opportunity recompute.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {!selectedSiteId ? (
          <p className="text-sm text-muted-foreground" data-testid="site-energy-rates-no-site">
            Select a site above to view and edit its energy rates.
          </p>
        ) : isLoading || !rates ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Electric ($/kWh)
                </label>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.001"
                  min="0"
                  value={form.electric_rate_per_kwh}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, electric_rate_per_kwh: e.target.value }))
                  }
                  className={field}
                  data-testid="rates-electric-input"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Demand ($/kW)
                </label>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={form.demand_charge_per_kw}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, demand_charge_per_kw: e.target.value }))
                  }
                  className={field}
                  data-testid="rates-demand-input"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Gas ($/therm)
                </label>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={form.therm_rate_usd}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, therm_rate_usd: e.target.value }))
                  }
                  className={field}
                  data-testid="rates-therm-input"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Currency
                </label>
                <input
                  type="text"
                  maxLength={8}
                  value={form.currency}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))
                  }
                  className={`${field} w-20`}
                  data-testid="rates-currency-input"
                />
              </div>
              <button
                type="button"
                onClick={handleSave}
                disabled={!dirty || updateMutation.isPending}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                data-testid="rates-save-button"
              >
                <Save className="h-4 w-4" />
                {updateMutation.isPending ? "Saving…" : "Save"}
              </button>
            </div>
            {updateMutation.isError && (
              <p className="text-sm text-destructive">
                {(updateMutation.error as Error)?.message ?? "Failed to save rates"}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Editing rates for <span className="font-medium">{selectedSite?.name ?? selectedSiteId}</span>.
              Last updated {new Date(rates.updated_at).toLocaleString()}.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
