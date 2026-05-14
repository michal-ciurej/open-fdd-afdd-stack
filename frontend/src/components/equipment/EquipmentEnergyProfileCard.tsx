"use client";

import { useEffect, useState } from "react";
import { Gauge, Save } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useEquipmentEnergyProfile,
  useUpdateEquipmentEnergyProfile,
} from "@/hooks/use-energy";
import type {
  EquipmentEnergyProfile,
  EquipmentEnergyProfileUpdateBody,
} from "@/types/api";

const field =
  "h-9 w-32 rounded-lg border border-border/60 bg-background px-3 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring";

type ProfileFieldKey = Exclude<
  keyof EquipmentEnergyProfile,
  "equipment_id" | "updated_at"
>;

type FieldSpec = {
  key: ProfileFieldKey;
  label: string;
  step?: string;
  min?: number;
  max?: number;
  help?: string;
};

const FIELDS: FieldSpec[] = [
  { key: "nameplate_kw", label: "Nameplate kW", step: "0.1", min: 0 },
  { key: "motor_hp", label: "Motor HP", step: "0.1", min: 0 },
  { key: "motor_efficiency", label: "Motor η (0–1)", step: "0.01", min: 0, max: 1 },
  { key: "design_cfm", label: "Design CFM", step: "1", min: 0 },
  { key: "design_sat_f", label: "Design SAT (°F)", step: "0.1" },
  {
    key: "design_static_pressure_inwc",
    label: "Design static (inWC)",
    step: "0.01",
    min: 0,
  },
  { key: "design_cop", label: "Design COP", step: "0.1", min: 0 },
  {
    key: "design_heating_efficiency",
    label: "Heating η (0–1)",
    step: "0.01",
    min: 0,
    max: 1,
  },
  {
    key: "occupied_hours_per_year",
    label: "Occupied hrs / yr",
    step: "1",
    min: 0,
    max: 8784,
  },
];

type FormState = Record<ProfileFieldKey, string>;

function toForm(profile: EquipmentEnergyProfile | undefined): FormState {
  const out = {} as FormState;
  for (const f of FIELDS) {
    const v = profile?.[f.key];
    out[f.key] = v == null ? "" : String(v);
  }
  return out;
}

function diffPayload(
  form: FormState,
  profile: EquipmentEnergyProfile | undefined,
): EquipmentEnergyProfileUpdateBody {
  const out: EquipmentEnergyProfileUpdateBody = {};
  for (const f of FIELDS) {
    const raw = form[f.key].trim();
    const current = profile?.[f.key] ?? null;
    if (raw === "") {
      if (current != null) out[f.key] = null;
      continue;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) continue;
    if (parsed !== current) out[f.key] = parsed;
  }
  return out;
}

type EquipmentEnergyProfileCardProps = {
  equipmentId: string;
  className?: string;
};

export function EquipmentEnergyProfileCard({
  equipmentId,
  className,
}: EquipmentEnergyProfileCardProps) {
  const { data: profile, isLoading } = useEquipmentEnergyProfile(equipmentId);
  const updateMutation = useUpdateEquipmentEnergyProfile(equipmentId);

  const [form, setForm] = useState<FormState>(() => toForm(undefined));

  useEffect(() => {
    setForm(toForm(profile));
  }, [profile, equipmentId]);

  const payload = diffPayload(form, profile);
  const dirty = Object.keys(payload).length > 0;

  function handleSave() {
    if (!dirty) return;
    updateMutation.mutate(payload);
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Gauge className="h-4 w-4 shrink-0" />
          Energy profile
        </CardTitle>
        <p className="text-sm font-normal text-muted-foreground">
          Nameplate and design values consumed by the energy opportunity calculator.
          Blank fields fall back to platform defaults at compute time.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
              {FIELDS.map((f) => (
                <div key={f.key}>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">
                    {f.label}
                  </label>
                  <input
                    type="number"
                    inputMode="decimal"
                    step={f.step}
                    min={f.min}
                    max={f.max}
                    value={form[f.key]}
                    onChange={(e) =>
                      setForm((s) => ({ ...s, [f.key]: e.target.value }))
                    }
                    className={field}
                    data-testid={`profile-${f.key}-input`}
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleSave}
                disabled={!dirty || updateMutation.isPending}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                data-testid="profile-save-button"
              >
                <Save className="h-4 w-4" />
                {updateMutation.isPending ? "Saving…" : "Save"}
              </button>
              {profile?.updated_at && !dirty && (
                <span className="text-xs text-muted-foreground">
                  Last updated {new Date(profile.updated_at).toLocaleString()}
                </span>
              )}
            </div>
            {updateMutation.isError && (
              <p className="text-sm text-destructive">
                {(updateMutation.error as Error)?.message ?? "Failed to save profile"}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
