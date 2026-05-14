"use client";

import { useEffect, useMemo, useState } from "react";
import { X, Save, Trash2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { listEnergyCalcTypes, previewEnergyOpportunity } from "@/lib/crud-api";
import {
  useCreateOpportunity,
  useDeleteOpportunity,
  useUpdateOpportunity,
} from "@/hooks/use-energy";
import { useEquipment } from "@/hooks/use-sites";
import type {
  EnergyCalcTypePublic,
  EnergyOpportunity,
  EnergyOpportunityResult,
  MeasureFamily,
} from "@/types/api";

/** Family → set of calc_type ids. Drives the template dropdown filter.
 *  Source of truth in code rather than DB so the UI can render without an
 *  extra round-trip; phase 3 will move this to fault_definitions.params. */
const FAMILY_TO_CALC_TYPES: Record<MeasureFamily, readonly string[]> = {
  runtime: [
    "runtime_electric_kw",
    "motor_hp_runtime",
    "plant_minimum_stack_kw",
    "lighting_watts",
    "short_cycle_financial",
    "chwst_reset_penalty_kw",
    "cop_gap_electric",
  ],
  setpoint_reset: [
    "ahu_sat_sensible_waste",
    "pressure_ratio_motor_kw",
    "vav_min_flow_reheat",
    "vfd_affinity_cube",
  ],
  airside_thermal: [
    "oa_heating_sensible",
    "oa_cooling_sensible",
    "missed_economizer_cooling",
    "enthalpy_wheel_proxy",
    "zone_simultaneous_sensible",
  ],
  degradation: [
    "sensible_coil_leak_kw",
    "fan_filter_dp_kw",
    "simultaneous_hydronic_btu",
    "boiler_standby_mix",
  ],
};

const FAMILY_LABELS: Record<MeasureFamily, string> = {
  runtime: "Runtime",
  setpoint_reset: "Setpoint reset",
  airside_thermal: "Airside thermal",
  degradation: "Degradation",
};

const FAMILIES: MeasureFamily[] = [
  "runtime",
  "setpoint_reset",
  "airside_thermal",
  "degradation",
];

const inputBase =
  "h-9 rounded-lg border border-border/60 bg-background px-3 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

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

type OpportunityFormDialogProps = {
  /** Pre-selected equipment when the dialog is opened from the equipment Energy
   *  tab. Omit to let the operator pick from a dropdown — used by the
   *  /energy-engineering "+ New opportunity" entry. */
  equipmentId?: string;
  /** Required when equipmentId is omitted, so the equipment dropdown can list
   *  only equipment from the active site. */
  siteId?: string;
  /** Existing opportunity for edit mode; omit to create. */
  opportunity?: EnergyOpportunity;
  onClose: () => void;
};

export function OpportunityFormDialog({
  equipmentId,
  siteId,
  opportunity,
  onClose,
}: OpportunityFormDialogProps) {
  const isEdit = !!opportunity;

  // When opened from the site ranking page (no equipmentId), the operator picks
  // an equipment first. Edit mode always derives the equipmentId from the
  // opportunity row.
  const [pickedEquipmentId, setPickedEquipmentId] = useState<string>(
    opportunity?.equipment_id ?? equipmentId ?? "",
  );
  const effectiveEquipmentId = equipmentId ?? pickedEquipmentId;
  const showEquipmentPicker = !isEdit && !equipmentId;
  const { data: equipmentList = [] } = useEquipment(
    showEquipmentPicker ? siteId : undefined,
  );

  const { data: calcTypesData } = useQuery({
    queryKey: ["energy-calc-types"],
    queryFn: listEnergyCalcTypes,
  });
  const calcTypes = calcTypesData?.calc_types ?? [];
  const calcTypeById = useMemo(
    () => new Map(calcTypes.map((c) => [c.id, c])),
    [calcTypes],
  );

  const [family, setFamily] = useState<MeasureFamily>(
    opportunity?.measure_family ?? "runtime",
  );
  const [calcTypeId, setCalcTypeId] = useState<string>(
    opportunity?.calc_type ?? "",
  );
  const [name, setName] = useState(opportunity?.name ?? "");
  const [externalId, setExternalId] = useState(opportunity?.external_id ?? "");
  const [capex, setCapex] = useState(String(opportunity?.capex_usd ?? 0));
  const [deltas, setDeltas] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(opportunity?.delta_params ?? {})) {
      out[k] = v == null ? "" : String(v);
    }
    return out;
  });

  const familyCalcTypes = useMemo(
    () =>
      (FAMILY_TO_CALC_TYPES[family] ?? [])
        .map((id) => calcTypeById.get(id))
        .filter((x): x is EnergyCalcTypePublic => !!x),
    [family, calcTypeById],
  );

  // Auto-pick the first calc type if none is selected for the current family.
  useEffect(() => {
    if (!calcTypeId && familyCalcTypes.length > 0) {
      setCalcTypeId(familyCalcTypes[0].id);
    }
  }, [calcTypeId, familyCalcTypes]);

  // Auto-fill external_id from name in create mode.
  useEffect(() => {
    if (!isEdit && name && !externalId) {
      setExternalId(slugify(name));
    }
  }, [name, externalId, isEdit]);

  const selectedSpec = calcTypeId ? calcTypeById.get(calcTypeId) : undefined;

  const deltaPayload = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(deltas)) {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      const asNumber = Number(trimmed);
      out[k] = Number.isFinite(asNumber) ? asNumber : trimmed;
    }
    return out;
  }, [deltas]);

  // Live preview, debounced via react-query cache key (calc_type + delta + capex).
  const previewKey = JSON.stringify({
    calcTypeId,
    deltaPayload,
    capex: Number(capex) || 0,
  });
  const { data: preview, isFetching: previewLoading } = useQuery<
    EnergyOpportunityResult
  >({
    queryKey: ["opportunity-preview", effectiveEquipmentId, previewKey],
    queryFn: () =>
      previewEnergyOpportunity({
        equipment_id: effectiveEquipmentId,
        calc_type: calcTypeId,
        delta_params: deltaPayload,
        capex_usd: Number(capex) || 0,
      }),
    enabled: !!calcTypeId && !!effectiveEquipmentId,
  });

  const createMut = useCreateOpportunity(effectiveEquipmentId || undefined);
  const updateMut = useUpdateOpportunity(effectiveEquipmentId || undefined);
  const deleteMut = useDeleteOpportunity(effectiveEquipmentId || undefined);

  const saving = createMut.isPending || updateMut.isPending;
  const saveError =
    (createMut.error as Error | undefined) ??
    (updateMut.error as Error | undefined);

  function handleSave() {
    if (!calcTypeId || !name.trim()) return;
    if (isEdit && opportunity) {
      updateMut.mutate(
        {
          id: opportunity.id,
          body: {
            name: name.trim(),
            measure_family: family,
            calc_type: calcTypeId,
            delta_params: deltaPayload,
            capex_usd: Number(capex) || 0,
          },
        },
        { onSuccess: onClose },
      );
    } else {
      if (!effectiveEquipmentId) return;
      createMut.mutate(
        {
          equipment_id: effectiveEquipmentId,
          external_id: externalId.trim() || slugify(name),
          name: name.trim(),
          measure_family: family,
          calc_type: calcTypeId,
          delta_params: deltaPayload,
          capex_usd: Number(capex) || 0,
          enabled: true,
        },
        { onSuccess: onClose },
      );
    }
  }

  function handleDelete() {
    if (!opportunity) return;
    if (!window.confirm(`Delete opportunity "${opportunity.name}"?`)) return;
    deleteMut.mutate(opportunity.id, { onSuccess: onClose });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border/60 bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="opportunity-form-dialog"
      >
        <header className="flex items-center justify-between border-b border-border/60 px-5 py-3">
          <h2 className="text-lg font-semibold">
            {isEdit ? "Edit opportunity" : "Add opportunity"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-5 px-5 py-4">
          {showEquipmentPicker && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Equipment
              </label>
              <select
                value={pickedEquipmentId}
                onChange={(e) => setPickedEquipmentId(e.target.value)}
                className={`${inputBase} w-full`}
                data-testid="opportunity-equipment-picker"
              >
                <option value="">Select equipment…</option>
                {equipmentList.map((eq) => (
                  <option key={eq.id} value={eq.id}>
                    {eq.name}
                    {eq.equipment_type ? ` — ${eq.equipment_type}` : ""}
                  </option>
                ))}
              </select>
              {equipmentList.length === 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  No equipment on this site yet. Add equipment via Data Model first.
                </p>
              )}
            </div>
          )}

          {/* Family + template */}
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Measure family
              </label>
              <div className="flex flex-wrap gap-2">
                {FAMILIES.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => {
                      setFamily(f);
                      setCalcTypeId("");
                    }}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                      family === f
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted/50 text-muted-foreground hover:bg-muted"
                    }`}
                    data-testid={`opportunity-family-${f}`}
                  >
                    {FAMILY_LABELS[f]}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Template
              </label>
              <select
                value={calcTypeId}
                onChange={(e) => setCalcTypeId(e.target.value)}
                className={`${inputBase} w-full`}
                data-testid="opportunity-calc-type"
              >
                <option value="">Select a template…</option>
                {familyCalcTypes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              {selectedSpec?.summary && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedSpec.summary}
                </p>
              )}
            </div>
          </div>

          {/* Naming */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="SAT reset (55→62)"
                className={`${inputBase} w-full`}
                data-testid="opportunity-name"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                External ID {isEdit && <span className="font-normal">(read-only)</span>}
              </label>
              <input
                type="text"
                value={externalId}
                onChange={(e) => setExternalId(e.target.value)}
                placeholder="sat_reset_ahu_03"
                disabled={isEdit}
                className={`${inputBase} w-full font-mono text-xs disabled:opacity-60`}
                data-testid="opportunity-external-id"
              />
            </div>
          </div>

          {/* Calc parameters */}
          {selectedSpec && (
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Inputs (blank = use equipment profile / site rates / platform default)
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {(selectedSpec.fields ?? []).map((f) => (
                  <div key={f.key}>
                    <label className="mb-1 block text-xs text-muted-foreground">
                      {f.label}
                      {f.default != null && (
                        <span className="ml-1 text-[10px] text-muted-foreground/70">
                          (default {String(f.default)})
                        </span>
                      )}
                    </label>
                    {f.type === "enum" && f.options ? (
                      <select
                        value={deltas[f.key] ?? ""}
                        onChange={(e) =>
                          setDeltas((d) => ({ ...d, [f.key]: e.target.value }))
                        }
                        className={`${inputBase} w-full`}
                      >
                        <option value="">—</option>
                        {f.options.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        value={deltas[f.key] ?? ""}
                        onChange={(e) =>
                          setDeltas((d) => ({ ...d, [f.key]: e.target.value }))
                        }
                        className={`${inputBase} w-full`}
                        data-testid={`opportunity-delta-${f.key}`}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Capex */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Capex (£)
            </label>
            <input
              type="number"
              inputMode="decimal"
              step="1"
              min="0"
              value={capex}
              onChange={(e) => setCapex(e.target.value)}
              className={`${inputBase} w-40`}
              data-testid="opportunity-capex"
            />
          </div>

          {/* Live preview */}
          <div className="rounded-xl border border-border/60 bg-muted/40 px-4 py-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Preview {previewLoading && <span className="ml-1">…</span>}
            </p>
            <div className="grid grid-cols-2 gap-2 text-sm tabular-nums sm:grid-cols-4">
              <div>
                <div className="text-xs text-muted-foreground">Savings/yr</div>
                <div className="font-semibold">
                  {fmtCurrency(preview?.annual_savings_usd ?? null)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">kWh/yr</div>
                <div>
                  {preview?.annual_kwh_saved != null
                    ? Math.round(preview.annual_kwh_saved).toLocaleString()
                    : "—"}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Payback</div>
                <div>{fmtYears(preview?.simple_payback_years ?? null)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Data</div>
                <div className="capitalize">
                  {preview?.data_quality ?? "—"}
                </div>
              </div>
            </div>
            {preview?.missing_inputs && preview.missing_inputs.length > 0 && (
              <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                Missing inputs: {preview.missing_inputs.join(", ")}
              </p>
            )}
          </div>

          {saveError && (
            <p className="text-sm text-destructive">{saveError.message}</p>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border/60 px-5 py-3">
          <div>
            {isEdit && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleteMut.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
                data-testid="opportunity-delete-button"
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border/60 px-3 py-1.5 text-sm hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!calcTypeId || !name.trim() || !effectiveEquipmentId || saving}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              data-testid="opportunity-save-button"
            >
              <Save className="h-4 w-4" />
              {saving ? "Saving…" : isEdit ? "Save changes" : "Save"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
