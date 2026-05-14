"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Code,
  Cog,
  FileUp,
  Play,
  Save,
  Wind,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { apiFetch } from "@/lib/api";
import { updateSite } from "@/lib/crud-api";
import { useSiteContext } from "@/contexts/site-context";
import {
  useSiteEnergyRates,
  useUpdateSiteEnergyRates,
} from "@/hooks/use-energy";
import type { SparqlResponse } from "@/types/api";
import { PREDEFINED_QUERIES, DEFAULT_SPARQL } from "@/data/data-model-testing-queries";

const inputBase =
  "h-9 rounded-lg border border-border/60 bg-background px-3 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring";

type SiteForm = {
  description: string;
  floorspace_sqm: string;
  core_occupancy_hours_per_year: string;
  electric_rate_per_kwh: string;
  demand_charge_per_kw: string;
  therm_rate_usd: string;
  currency: string;
};

const EMPTY_FORM: SiteForm = {
  description: "",
  floorspace_sqm: "",
  core_occupancy_hours_per_year: "",
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
      core_occupancy_hours_per_year:
        metadata.core_occupancy_hours_per_year == null
          ? ""
          : String(metadata.core_occupancy_hours_per_year),
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
    const occHours = numOrUndefined(form.core_occupancy_hours_per_year);
    const electric = numOrUndefined(form.electric_rate_per_kwh);
    const demand = numOrUndefined(form.demand_charge_per_kw);
    const therm = numOrUndefined(form.therm_rate_usd);

    // Build site PATCH (deep-merged on the server). Only send what changed
    // shape-wise; the existing metadata branch merges with whatever's there.
    const sitePatch: Parameters<typeof updateSite>[1] = {};
    const currentMetadata = (selectedSite?.metadata ?? {}) as Record<string, unknown>;
    const nextMetadata: Record<string, unknown> = {};
    if (floorspace !== undefined) nextMetadata.floorspace_sqm = floorspace;
    if (occHours !== undefined) nextMetadata.core_occupancy_hours_per_year = occHours;
    if (
      nextMetadata.floorspace_sqm !== currentMetadata.floorspace_sqm ||
      nextMetadata.core_occupancy_hours_per_year !==
        currentMetadata.core_occupancy_hours_per_year
    ) {
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
      // Always send a rates PUT — partial payload merges server-side. Skip the
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
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Core occupancy hrs / yr
              </label>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                max="8784"
                step="1"
                value={form.core_occupancy_hours_per_year}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    core_occupancy_hours_per_year: e.target.value,
                  }))
                }
                className={`${inputBase} w-full`}
                data-testid="building-occupancy-input"
              />
              <p className="mt-1 text-xs text-muted-foreground/80">
                e.g. 2600 for Mon–Fri 8 to 18.
              </p>
            </div>
          </div>
        </section>

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

function BuildingQueriesCard() {
  const [sparqlQuery, setSparqlQuery] = useState(DEFAULT_SPARQL);
  const [sparqlError, setSparqlError] = useState<string | null>(null);
  const [includeBacnetRefs, setIncludeBacnetRefs] = useState(false);
  const [queryCategory, setQueryCategory] = useState<"hvac" | "engineering">("hvac");
  // Test signal that increments on every settle (success or error) so E2E
  // can wait for the table to refresh without polling DOM text.
  const [sparqlFinishedGen, setSparqlFinishedGen] = useState(0);
  const sparqlFileInputRef = useRef<HTMLInputElement>(null);

  const sparqlMutation = useMutation<SparqlResponse, Error, string>({
    mutationFn: (query) =>
      apiFetch<SparqlResponse>("/data-model/sparql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      }),
    onSuccess: () => setSparqlError(null),
    onError: (err: Error) => setSparqlError(err.message),
    onSettled: () => setSparqlFinishedGen((g) => g + 1),
  });

  const runPredefined = (query: string, queryWithBacnet?: string) => {
    const q = includeBacnetRefs && queryWithBacnet ? queryWithBacnet : query;
    setSparqlQuery(q);
    sparqlMutation.mutate(q);
  };

  const sparqlBindings: Record<string, string | null>[] =
    sparqlMutation.data?.bindings ?? [];
  const sparqlColumns =
    sparqlBindings.length > 0
      ? Array.from(new Set(sparqlBindings.flatMap((r) => Object.keys(r)))).sort()
      : [];

  return (
    <Card>
      <span
        data-testid="sparql-finished-generation"
        data-gen={sparqlFinishedGen}
        className="hidden"
        aria-hidden={true}
      />
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Wind className="h-5 w-5 shrink-0" />
          Building model queries
        </CardTitle>
        <p className="text-sm font-normal text-muted-foreground">
          Predefined SPARQL summaries plus a freeform query box. Results show below the
          form. AI-assisted queries land in a future revision.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Predefined */}
        <section>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setQueryCategory("hvac")}
              data-testid="category-hvac-button"
              aria-pressed={queryCategory === "hvac"}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                queryCategory === "hvac"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              HVAC
            </button>
            <button
              type="button"
              onClick={() => setQueryCategory("engineering")}
              data-testid="category-engineering-button"
              aria-pressed={queryCategory === "engineering"}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                queryCategory === "engineering"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              Engineering
            </button>
            <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={includeBacnetRefs}
                onChange={(e) => setIncludeBacnetRefs(e.target.checked)}
                className="h-4 w-4 rounded border-input"
                data-testid="include-bacnet-refs-checkbox"
              />
              <span>Include BACnet device + point IDs</span>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {PREDEFINED_QUERIES.filter(
              (q) => (q.category ?? "hvac") === queryCategory,
            ).map(({ id, label, shortLabel, query, queryWithBacnet, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => runPredefined(query, queryWithBacnet)}
                disabled={sparqlMutation.isPending}
                className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-60"
                title={label}
              >
                <Icon className="h-4 w-4" />
                {shortLabel}
              </button>
            ))}
            {sparqlMutation.isPending && (
              <span
                className="inline-flex items-center gap-2 text-sm text-primary"
                data-testid="sparql-running-indicator"
                role="status"
                aria-live="polite"
                aria-busy="true"
              >
                <Cog className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                Running SPARQL…
              </span>
            )}
          </div>
        </section>

        {/* Custom SPARQL */}
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Code className="h-3.5 w-3.5" />
            Custom SPARQL
          </h3>
          <input
            ref={sparqlFileInputRef}
            type="file"
            accept=".sparql,text/plain"
            className="hidden"
            data-testid="sparql-file-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => {
                const text = typeof reader.result === "string" ? reader.result : "";
                setSparqlQuery(text);
              };
              reader.readAsText(file);
              e.target.value = "";
            }}
          />
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="sparql-upload-file-button"
              onClick={() => sparqlFileInputRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-card px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted/80"
            >
              <FileUp className="h-4 w-4" />
              Upload .sparql
            </button>
            <button
              type="button"
              data-testid="sparql-run-button"
              onClick={() => sparqlMutation.mutate(sparqlQuery)}
              disabled={sparqlMutation.isPending || !sparqlQuery.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {sparqlMutation.isPending ? (
                <Cog className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
              ) : (
                <Play className="h-4 w-4" aria-hidden />
              )}
              {sparqlMutation.isPending ? "Running…" : "Run SPARQL"}
            </button>
          </div>
          <textarea
            data-testid="sparql-query-textarea"
            value={sparqlQuery}
            onChange={(e) => setSparqlQuery(e.target.value)}
            className="h-40 w-full rounded-lg border border-border/60 bg-card px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            spellCheck={false}
          />
          {sparqlError && (
            <p className="mt-2 text-sm text-destructive" data-testid="sparql-error">
              {sparqlError}
            </p>
          )}
        </section>

        {/* Results */}
        {sparqlBindings.length > 0 && sparqlColumns.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Results
            </h3>
            <div
              className="overflow-x-auto rounded-lg border border-border/60"
              data-testid="sparql-results-table"
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    {sparqlColumns.map((key) => (
                      <TableHead key={key} className="font-mono text-xs">
                        {key}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sparqlBindings.map((row: Record<string, string | null>, i: number) => (
                    <TableRow key={i}>
                      {sparqlColumns.map((key) => (
                        <TableCell key={key} className="font-mono text-xs">
                          {row[key] ?? "—"}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        )}
        {sparqlMutation.isSuccess && sparqlBindings.length === 0 && (
          <p className="text-sm text-muted-foreground">No bindings (empty result).</p>
        )}
      </CardContent>
    </Card>
  );
}

export function MyBuildingPage() {
  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">My Building</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Overview and editable settings for the selected site, plus tools for inspecting
        the underlying building model.
      </p>

      <SiteSummaryCard />
      <BuildingQueriesCard />
    </div>
  );
}
