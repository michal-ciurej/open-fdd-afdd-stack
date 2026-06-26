"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, Save } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { updateSite } from "@/lib/crud-api";
import { SiteScheduleEditor } from "@/components/site/SiteScheduleEditor";
import { useSiteContext } from "@/contexts/site-context";
import {
  useSiteEnergyRates,
  useUpdateSiteEnergyRates,
} from "@/hooks/use-energy";

const inputBase =
  "h-9 rounded-lg border border-border/60 bg-background px-3 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring";

type SiteForm = {
  description: string;
  floorspace_sqm: string;
  electric_rate_per_kwh: string;
  demand_charge_per_kw: string;
  therm_rate_usd: string;
  currency: string;
};

const EMPTY_FORM: SiteForm = {
  description: "",
  floorspace_sqm: "",
  electric_rate_per_kwh: "",
  demand_charge_per_kw: "",
  therm_rate_usd: "",
  currency: "GBP",
};

function numOrUndefined(s: string): number | undefined {
  const t = s.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function SiteSummaryCard() {
  const { selectedSiteId, selectedSite } = useSiteContext();
  const queryClient = useQueryClient();
  const { data: rates } = useSiteEnergyRates(selectedSiteId ?? undefined);
  const updateRates = useUpdateSiteEnergyRates(selectedSiteId ?? undefined);

  const [form, setForm] = useState<SiteForm>(EMPTY_FORM);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);

  // Reset form whenever site or rates change.
  useEffect(() => {
    if (!selectedSite) {
      setForm(EMPTY_FORM);
      return;
    }
    const metadata = (selectedSite.metadata ?? {}) as Record<string, unknown>;
    setForm({
      description: selectedSite.description ?? "",
      floorspace_sqm:
        metadata.floorspace_sqm == null ? "" : String(metadata.floorspace_sqm),
      electric_rate_per_kwh:
        rates?.electric_rate_per_kwh != null
          ? String(rates.electric_rate_per_kwh)
          : "",
      demand_charge_per_kw:
        rates?.demand_charge_per_kw != null
          ? String(rates.demand_charge_per_kw)
          : "",
      therm_rate_usd:
        rates?.therm_rate_usd != null ? String(rates.therm_rate_usd) : "",
      currency: rates?.currency ?? "GBP",
    });
  }, [selectedSite, rates]);

  const siteMutation = useMutation({
    mutationFn: (body: Parameters<typeof updateSite>[1]) =>
      updateSite(selectedSiteId as string, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sites"] });
    },
  });

  const saving = siteMutation.isPending || updateRates.isPending;

  async function handleSave() {
    if (!selectedSiteId) return;
    setSaveError(null);
    setSaveOk(false);

    const floorspace = numOrUndefined(form.floorspace_sqm);
    const electric = numOrUndefined(form.electric_rate_per_kwh);
    const demand = numOrUndefined(form.demand_charge_per_kw);
    const therm = numOrUndefined(form.therm_rate_usd);

    // Build site PATCH (deep-merged on the server). Only send what changed
    // shape-wise; the existing metadata branch merges with whatever's there.
    const sitePatch: Parameters<typeof updateSite>[1] = {};
    const currentMetadata = (selectedSite?.metadata ?? {}) as Record<string, unknown>;
    const nextMetadata: Record<string, unknown> = {};
    if (floorspace !== undefined) nextMetadata.floorspace_sqm = floorspace;
    if (nextMetadata.floorspace_sqm !== currentMetadata.floorspace_sqm) {
      sitePatch.metadata = nextMetadata;
    }
    if (form.description.trim() !== (selectedSite?.description ?? "")) {
      sitePatch.description = form.description.trim() || null;
    }

    try {
      const promises: Promise<unknown>[] = [];
      if (Object.keys(sitePatch).length > 0) {
        promises.push(siteMutation.mutateAsync(sitePatch));
      }
      // Always send a rates PUT - partial payload merges server-side. Skip the
      // call only when no rate fields are provided.
      const ratesBody: Parameters<typeof updateRates.mutateAsync>[0] = {};
      if (electric !== undefined) ratesBody.electric_rate_per_kwh = electric;
      if (demand !== undefined) ratesBody.demand_charge_per_kw = demand;
      if (therm !== undefined) ratesBody.therm_rate_usd = therm;
      if (form.currency.trim() && form.currency.trim() !== (rates?.currency ?? "")) {
        ratesBody.currency = form.currency.trim();
      }
      if (Object.keys(ratesBody).length > 0) {
        promises.push(updateRates.mutateAsync(ratesBody));
      }
      if (promises.length === 0) {
        setSaveOk(true);
        return;
      }
      await Promise.all(promises);
      setSaveOk(true);
    } catch (e) {
      setSaveError((e as Error).message ?? "Failed to save");
    }
  }

  if (!selectedSiteId) {
    return (
      <Card className="mb-6">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          Select a site from the sidebar to view its overview and metadata.
        </CardContent>
      </Card>
    );
  }

  if (!selectedSite) {
    return (
      <Card className="mb-6">
        <CardContent className="py-6">
          <Skeleton className="h-24 w-full rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mb-6">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Building2 className="h-5 w-5 shrink-0" />
          {selectedSite.name}
        </CardTitle>
        <p className="text-sm font-normal text-muted-foreground">
          Site overview and editable metadata. Floorspace, core occupancy hours, and
          energy rates feed the cost calculator and the FDD loop.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Description */}
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Description
          </label>
          <input
            type="text"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            placeholder="Short description of the building"
            className={`${inputBase} w-full sm:max-w-lg`}
            data-testid="building-description-input"
          />
        </div>

        {/* Metadata section */}
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Building metadata
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Floorspace (m²)
              </label>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="1"
                value={form.floorspace_sqm}
                onChange={(e) =>
                  setForm((f) => ({ ...f, floorspace_sqm: e.target.value }))
                }
                className={`${inputBase} w-full`}
                data-testid="building-floorspace-input"
              />
            </div>
          </div>
        </section>

        {/* Core occupancy schedule - replaces the old hrs/year scalar. */}
        <SiteScheduleEditor siteId={selectedSiteId} />

        {/* Energy rates section */}
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Energy rates
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Electric (£/kWh)
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
                className={`${inputBase} w-full`}
                data-testid="building-electric-rate-input"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Demand (£/kW)
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
                className={`${inputBase} w-full`}
                data-testid="building-demand-rate-input"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Gas (£/therm)
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
                className={`${inputBase} w-full`}
                data-testid="building-therm-rate-input"
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
                className={`${inputBase} w-full`}
                data-testid="building-currency-input"
              />
            </div>
          </div>
        </section>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            data-testid="building-save-button"
          >
            <Save className="h-4 w-4" />
            {saving ? "Saving…" : "Save changes"}
          </button>
          {saveOk && !saveError && (
            <span className="text-xs text-muted-foreground" data-testid="building-save-ok">
              Saved.
            </span>
          )}
          {saveError && (
            <p className="text-sm text-destructive" data-testid="building-save-error">
              {saveError}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function MyBuildingPage() {
  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Building Setup</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Editable settings for the selected site - description, floorspace, core occupancy
        schedule, and energy rates. These feed the cost calculator and the FDD loop.
      </p>

      <SiteSummaryCard />
    </div>
  );
}
