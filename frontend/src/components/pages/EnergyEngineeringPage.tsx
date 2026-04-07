import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSiteContext } from "@/contexts/site-context";
import { useEquipment } from "@/hooks/use-sites";
import {
  createEnergyCalculation,
  deleteEnergyCalculation,
  listEnergyCalculations,
  listEnergyCalcTypes,
  previewEnergyCalculation,
} from "@/lib/crud-api";
import type { EnergyCalcFieldSpec, EnergyCalcTypePublic, EnergyCalculation, EnergyPreviewResult } from "@/types/api";
import { EquipmentMetadataTab } from "./equipment-metadata-tab";

function slugFromName(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return s || "energy_calc";
}

function defaultsFromFields(fields: EnergyCalcFieldSpec[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of fields) {
    if (f.default !== undefined && f.default !== null) o[f.key] = String(f.default);
    else o[f.key] = "";
  }
  return o;
}

function buildParametersFromForm(
  fields: EnergyCalcFieldSpec[],
  raw: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = raw[f.key]?.trim() ?? "";
    if (v === "") continue;
    if (f.type === "float") {
      const n = Number(v);
      if (!Number.isNaN(n)) out[f.key] = n;
    } else if (f.type === "enum") {
      out[f.key] = v;
    } else {
      out[f.key] = v;
    }
  }
  return out;
}

function EnergyCalculationWorkbench() {
  const queryClient = useQueryClient();
  const { selectedSiteId } = useSiteContext();
  const { data: siteEquipment = [] } = useEquipment(selectedSiteId ?? undefined);

  const typesQuery = useQuery({
    queryKey: ["energy-calc-types"],
    queryFn: listEnergyCalcTypes,
  });

  const calcTypes = typesQuery.data?.calc_types ?? [];
  const [calcTypeId, setCalcTypeId] = useState<string>("");
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [externalId, setExternalId] = useState("");
  const [equipmentId, setEquipmentId] = useState<string>("");
  const [pointBindingsText, setPointBindingsText] = useState("{}");
  const [preview, setPreview] = useState<EnergyPreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const activeSpec: EnergyCalcTypePublic | undefined = useMemo(
    () => calcTypes.find((c) => c.id === calcTypeId),
    [calcTypes, calcTypeId],
  );

  useEffect(() => {
    if (!calcTypes.length) return;
    if (!calcTypeId || !calcTypes.some((c) => c.id === calcTypeId)) {
      const first = calcTypes[0];
      setCalcTypeId(first.id);
      setParamValues(defaultsFromFields(first.fields));
    }
  }, [calcTypes, calcTypeId]);

  const onCalcTypeChange = useCallback(
    (id: string) => {
      setCalcTypeId(id);
      const spec = calcTypes.find((c) => c.id === id);
      if (spec) setParamValues(defaultsFromFields(spec.fields));
      setPreview(null);
      setPreviewError(null);
    },
    [calcTypes],
  );

  const listQuery = useQuery({
    queryKey: ["energy-calculations", selectedSiteId],
    queryFn: () => listEnergyCalculations(selectedSiteId!),
    enabled: Boolean(selectedSiteId),
  });

  const previewMut = useMutation({
    mutationFn: async () => {
      if (!activeSpec) throw new Error("No calculation type selected.");
      const parameters = buildParametersFromForm(activeSpec.fields, paramValues);
      return previewEnergyCalculation(calcTypeId, parameters);
    },
    onSuccess: (data) => {
      setPreview(data);
      setPreviewError(null);
    },
    onError: (e: Error) => {
      setPreview(null);
      setPreviewError(e.message);
    },
  });

  const createMut = useMutation({
    mutationFn: async () => {
      if (!selectedSiteId) throw new Error("Select a site first.");
      if (!activeSpec) throw new Error("No calculation type selected.");
      let point_bindings: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(pointBindingsText || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          point_bindings = parsed as Record<string, unknown>;
        }
      } catch {
        throw new Error("Point bindings must be valid JSON object.");
      }
      const parameters = buildParametersFromForm(activeSpec.fields, paramValues);
      const ext = externalId.trim() || slugFromName(name);
      if (!ext) throw new Error("Name or external id is required.");
      const body = {
        site_id: selectedSiteId,
        equipment_id: equipmentId.trim() || null,
        external_id: ext,
        name: name.trim() || ext,
        description: description.trim() || null,
        calc_type: calcTypeId,
        parameters,
        point_bindings,
        enabled: true,
      };
      return createEnergyCalculation(body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["energy-calculations", selectedSiteId] });
      void queryClient.invalidateQueries({ queryKey: ["data-model"] });
      setName("");
      setDescription("");
      setExternalId("");
      setPreview(null);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteEnergyCalculation(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["energy-calculations", selectedSiteId] });
      void queryClient.invalidateQueries({ queryKey: ["data-model"] });
    },
  });

  useEffect(() => {
    if (!name.trim()) return;
    if (!externalId.trim()) setExternalId(slugFromName(name));
  }, [name, externalId]);

  if (!selectedSiteId) {
    return (
      <p className="text-sm text-muted-foreground">
        Select a site in the header. Energy calculations are stored per site—each building has different equipment,
        points, and savings logic, so nothing here applies globally.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Define FDD-oriented savings estimates for <strong>this site only</strong>. Saved rows sync to Postgres and into{" "}
        <code className="rounded bg-muted px-1 text-xs">config/data_model.ttl</code> as{" "}
        <code className="rounded bg-muted px-1 text-xs">ofdd:EnergyCalculation</code> linked with{" "}
        <code className="rounded bg-muted px-1 text-xs">brick:isPartOf</code> the site. Preview uses static inputs;
        interval and fault-duration analytics are planned separately.
      </p>

      {typesQuery.isError && (
        <p className="text-sm text-destructive">Could not load calculation types: {(typesQuery.error as Error).message}</p>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">New calculation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="block text-sm" htmlFor="eecalc-type">
            <span className="mb-1 block text-xs text-muted-foreground">Calculation type</span>
            <select
              id="eecalc-type"
              className="h-9 w-full max-w-xl rounded-lg border border-border/60 bg-background px-3 text-sm"
              value={calcTypeId}
              onChange={(e) => onCalcTypeChange(e.target.value)}
              disabled={!calcTypes.length}
            >
              {calcTypes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {activeSpec && (
            <p className="text-xs text-muted-foreground">
              {activeSpec.summary} <span className="opacity-70">({activeSpec.category})</span>
            </p>
          )}

          <div className="grid max-w-xl grid-cols-1 gap-3 md:grid-cols-2">
            <label className="text-sm" htmlFor="eecalc-name">
              <span className="mb-1 block text-xs text-muted-foreground">Display name</span>
              <input
                id="eecalc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-9 w-full rounded-lg border border-border/60 bg-background px-3 text-sm"
                placeholder="e.g. AHU-1 excess OA heating"
              />
            </label>
            <label className="text-sm" htmlFor="eecalc-extid">
              <span className="mb-1 block text-xs text-muted-foreground">External id (unique per site)</span>
              <input
                id="eecalc-extid"
                value={externalId}
                onChange={(e) => setExternalId(e.target.value)}
                className="h-9 w-full rounded-lg border border-border/60 bg-background px-3 text-sm"
                placeholder="slug"
              />
            </label>
          </div>

          <label className="block text-sm" htmlFor="eecalc-desc">
            <span className="mb-1 block text-xs text-muted-foreground">Description (optional)</span>
            <input
              id="eecalc-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="h-9 w-full max-w-2xl rounded-lg border border-border/60 bg-background px-3 text-sm"
            />
          </label>

          <label className="block text-sm" htmlFor="eecalc-eq">
            <span className="mb-1 block text-xs text-muted-foreground">Equipment (optional)</span>
            <select
              id="eecalc-eq"
              className="h-9 w-full max-w-xl rounded-lg border border-border/60 bg-background px-3 text-sm"
              value={equipmentId}
              onChange={(e) => setEquipmentId(e.target.value)}
            >
              <option value="">— Site-level (not tied to one asset) —</option>
              {siteEquipment.map((eq) => (
                <option key={eq.id} value={eq.id}>
                  {eq.name} ({eq.equipment_type ?? "Equipment"})
                </option>
              ))}
            </select>
          </label>

          {activeSpec && (
            <div className="grid max-w-3xl grid-cols-1 gap-3 md:grid-cols-2">
              {activeSpec.fields.map((f) => {
                const id = `eecalc-field-${f.key}`;
                if (f.type === "enum" && f.options?.length) {
                  return (
                    <label key={f.key} className="text-sm" htmlFor={id}>
                      <span className="mb-1 block text-xs text-muted-foreground">{f.label}</span>
                      <select
                        id={id}
                        className="h-9 w-full rounded-lg border border-border/60 bg-background px-3 text-sm"
                        value={paramValues[f.key] ?? ""}
                        onChange={(e) => setParamValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                      >
                        <option value="">—</option>
                        {f.options.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                }
                return (
                  <label key={f.key} className="text-sm" htmlFor={id}>
                    <span className="mb-1 block text-xs text-muted-foreground">
                      {f.label}
                      {f.min != null || f.max != null ? (
                        <span className="opacity-70">
                          {" "}
                          ({f.min != null ? `min ${f.min}` : ""}
                          {f.min != null && f.max != null ? ", " : ""}
                          {f.max != null ? `max ${f.max}` : ""})
                        </span>
                      ) : null}
                    </span>
                    <input
                      id={id}
                      type="text"
                      inputMode="decimal"
                      value={paramValues[f.key] ?? ""}
                      onChange={(e) => setParamValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                      className="h-9 w-full rounded-lg border border-border/60 bg-background px-3 text-sm font-mono"
                    />
                  </label>
                );
              })}
            </div>
          )}

          <label className="block text-sm" htmlFor="eecalc-pb">
            <span className="mb-1 block text-xs text-muted-foreground">Point bindings JSON (optional)</span>
            <textarea
              id="eecalc-pb"
              value={pointBindingsText}
              onChange={(e) => setPointBindingsText(e.target.value)}
              className="h-24 w-full max-w-2xl rounded-lg border border-border/60 bg-card px-3 py-2 font-mono text-xs"
              spellCheck={false}
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => previewMut.mutate()}
              disabled={previewMut.isPending || !activeSpec}
              className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {previewMut.isPending ? "Preview…" : "Preview"}
            </button>
            <button
              type="button"
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending || !activeSpec}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {createMut.isPending ? "Saving…" : "Save to site"}
            </button>
          </div>
          {previewError && <p className="text-sm text-destructive">{previewError}</p>}
          {createMut.isError && (
            <p className="text-sm text-destructive">{(createMut.error as Error).message}</p>
          )}
          {preview && (
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm">
              <p className="font-medium">Preview</p>
              <ul className="mt-2 grid list-none gap-1 text-xs text-muted-foreground md:grid-cols-2">
                <li>kWh (annual est.): {preview.annual_kwh_saved ?? "—"}</li>
                <li>Therms (annual est.): {preview.annual_therms_saved ?? "—"}</li>
                <li>Cost USD (annual est.): {preview.annual_cost_saved_usd ?? "—"}</li>
                <li>Peak kW reduced: {preview.peak_kw_reduced ?? "—"}</li>
                <li>Confidence: {preview.confidence_score ?? "—"}</li>
                <li>Missing inputs: {(preview.missing_inputs ?? []).join(", ") || "none"}</li>
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">{preview.notes}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Saved for this site</CardTitle>
        </CardHeader>
        <CardContent>
          {listQuery.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {listQuery.isError && (
            <p className="text-sm text-destructive">{(listQuery.error as Error).message}</p>
          )}
          {listQuery.data && listQuery.data.length === 0 && (
            <p className="text-sm text-muted-foreground">No energy calculations yet for this site.</p>
          )}
          {listQuery.data && listQuery.data.length > 0 && (
            <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
              {listQuery.data.map((row: EnergyCalculation) => (
                <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div>
                    <span className="font-medium">{row.name}</span>{" "}
                    <code className="rounded bg-muted px-1 text-xs">{row.external_id}</code>{" "}
                    <span className="text-muted-foreground">· {row.calc_type}</span>
                    {!row.enabled && <span className="text-xs text-amber-600"> (disabled)</span>}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Delete "${row.name}"?`)) deleteMut.mutate(row.id);
                    }}
                    className="text-xs text-destructive underline-offset-2 hover:underline"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

type TabId = "energy" | "metadata";

export function EnergyEngineeringPage() {
  const [tab, setTab] = useState<TabId>("energy");

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Energy Engineering</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        HVAC and control layouts differ by site. Use the energy workbench for savings specs tied to this
        building&apos;s model; use equipment metadata when you need nameplate fields and topology export.
      </p>

      <div className="mb-6 flex flex-wrap gap-2 border-b border-border/60 pb-2">
        <button
          type="button"
          onClick={() => setTab("energy")}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
            tab === "energy" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/60"
          }`}
        >
          Energy calculations
        </button>
        <button
          type="button"
          onClick={() => setTab("metadata")}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
            tab === "metadata" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/60"
          }`}
        >
          Equipment metadata
        </button>
      </div>

      {tab === "energy" ? <EnergyCalculationWorkbench /> : <EquipmentMetadataTab />}
    </div>
  );
}
