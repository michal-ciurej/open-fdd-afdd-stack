import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Loader2, Check, AlertTriangle, Wand2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useSiteContext } from "@/contexts/site-context";
import { dataModelAiTag, dataModelImport } from "@/lib/crud-api";
import { BRICK_14_QUERY_CLASS_ALLOWLIST } from "@/data/brick-1.4-query-class-allowlist";
import type {
  AiTagRequest,
  DataModelImportBody,
  DataModelImportResponse,
  TaggingProposal,
  TaggingProposalEquipment,
  TaggingProposalPoint,
} from "@/types/api";

const INPUT_CLS =
  "w-full rounded border border-border/60 bg-card px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

const BRICK_CLASS_OPTIONS = Array.from(BRICK_14_QUERY_CLASS_ALLOWLIST).sort();

/** Drop the review-only fields so the row matches the strict import contract. */
function stripReview<T extends { confidence?: unknown; rationale?: unknown }>(
  row: T,
): Omit<T, "confidence" | "rationale"> {
  const clone = { ...row } as Record<string, unknown>;
  delete clone.confidence;
  delete clone.rationale;
  return clone as Omit<T, "confidence" | "rationale">;
}

function confidenceBadge(conf: number | null | undefined) {
  if (conf == null) return <Badge variant="outline">no score</Badge>;
  const pct = Math.round(conf * 100);
  const variant = conf >= 0.8 ? "success" : conf >= 0.5 ? "warning" : "destructive";
  return <Badge variant={variant}>{pct}%</Badge>;
}

/** Stable display key for a point row (BACnet object or external id). */
function pointLabel(p: TaggingProposalPoint): string {
  return (
    p.object_name ||
    p.external_id ||
    [p.bacnet_device_id, p.object_identifier].filter(Boolean).join(" ") ||
    p.point_id ||
    "point"
  );
}

export function AiTaggingPanel({ available }: { available: boolean | undefined }) {
  const queryClient = useQueryClient();
  const { selectedSiteId } = useSiteContext();

  // Pre-flight form (the operator job context that steers polling/units).
  const [faults, setFaults] = useState("");
  const [rulesYaml, setRulesYaml] = useState("");
  const [unitsMode, setUnitsMode] = useState<"imperial" | "metric" | "">("");
  const [production, setProduction] = useState(true);
  const [weather, setWeather] = useState(false);
  const [pollingMode, setPollingMode] = useState<"rules_only" | "rules_plus_trending" | "">("");
  const [notes, setNotes] = useState("");
  const [model, setModel] = useState("");

  // Editable proposal (held in state — ephemeral, no DB write until Onboard).
  const [points, setPoints] = useState<TaggingProposalPoint[] | null>(null);
  const [equipment, setEquipment] = useState<TaggingProposalEquipment[]>([]);
  const [meta, setMeta] = useState<Pick<TaggingProposal, "warnings" | "model" | "usage" | "chunks"> | null>(null);
  const [importResult, setImportResult] = useState<DataModelImportResponse | null>(null);

  const tagMutation = useMutation<TaggingProposal, Error, AiTagRequest>({
    mutationFn: dataModelAiTag,
    onSuccess: (proposal) => {
      setPoints(proposal.points);
      setEquipment(proposal.equipment);
      setMeta({
        warnings: proposal.warnings,
        model: proposal.model,
        usage: proposal.usage,
        chunks: proposal.chunks,
      });
      setImportResult(null);
    },
  });

  const importMutation = useMutation<DataModelImportResponse, Error, DataModelImportBody>({
    mutationFn: dataModelImport,
    onSuccess: (data) => {
      setImportResult(data);
      // Onboarded — clear the proposal and refresh everything the data model feeds.
      setPoints(null);
      setEquipment([]);
      queryClient.invalidateQueries({ queryKey: ["data-model"] });
      queryClient.invalidateQueries({ queryKey: ["sites"] });
      queryClient.invalidateQueries({ queryKey: ["equipment"] });
      queryClient.invalidateQueries({ queryKey: ["points"] });
    },
  });

  function runTagging() {
    const body: AiTagRequest = {
      site_id: selectedSiteId ?? null,
      faults: faults.trim() || null,
      rules_yaml: rulesYaml.trim() || null,
      units_mode: unitsMode || null,
      production,
      weather,
      polling_mode: pollingMode || null,
      notes: notes.trim() || null,
      model: model.trim() || null,
    };
    tagMutation.mutate(body);
  }

  function onboard() {
    if (!points) return;
    const body: DataModelImportBody = {
      points: points.map(stripReview),
      // Only send equipment rows that can be resolved (name or id).
      equipment: equipment
        .filter((e) => (e.equipment_name && e.equipment_name.trim()) || e.equipment_id)
        .map(stripReview),
    };
    importMutation.mutate(body);
  }

  // Group points by equipment for the review screen, preserving the array index
  // so edits write back to the right row.
  const grouped = useMemo(() => {
    const groups = new Map<string, { idx: number; p: TaggingProposalPoint }[]>();
    (points ?? []).forEach((p, idx) => {
      const key = (p.equipment_name && p.equipment_name.trim()) || "Unassigned";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ idx, p });
    });
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [points]);

  const updatePoint = (idx: number, patch: Partial<TaggingProposalPoint>) =>
    setPoints((prev) => prev?.map((p, i) => (i === idx ? { ...p, ...patch } : p)) ?? prev);

  const updateEquipmentType = (name: string, equipment_type: string) =>
    setEquipment((prev) =>
      prev.map((e) => (e.equipment_name === name ? { ...e, equipment_type } : e)),
    );

  const equipmentByName = useMemo(
    () => new Map(equipment.map((e) => [e.equipment_name ?? "", e])),
    [equipment],
  );

  const lowConfidenceCount = (points ?? []).filter(
    (p) => p.confidence != null && p.confidence < 0.5,
  ).length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Sparkles className="h-5 w-5" />
          AI tagging (Anthropic)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {available === false ? (
          <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            AI tagging is not configured on this server. Set{" "}
            <code className="rounded bg-muted px-1 text-xs">ANTHROPIC_API_KEY</code> on the API to
            enable it, then reload. The manual Export / Import flow below always works.
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Tags scanned BACnet points + DB points with Brick types and groups them into
              equipment using Claude, then lets you review and correct before onboarding into the
              data model. Scopes to the site selected in the top bar
              {selectedSiteId ? "" : " (All sites — tags everything)"}. Nothing is written until you
              click <strong>Onboard</strong>.
            </p>

            {/* --- Pre-flight / organise --- */}
            {!points && (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">
                      Faults / rules you will run
                    </span>
                    <input
                      className={INPUT_CLS}
                      value={faults}
                      onChange={(e) => setFaults(e.target.value)}
                      placeholder="e.g. sensor-bounds, ahu temp flatline"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">
                      Units mode
                    </span>
                    <select
                      className={INPUT_CLS}
                      value={unitsMode}
                      onChange={(e) => setUnitsMode(e.target.value as typeof unitsMode)}
                    >
                      <option value="">unspecified</option>
                      <option value="imperial">imperial (degF, cfm)</option>
                      <option value="metric">metric (degC)</option>
                    </select>
                  </label>
                </div>
                <label className="space-y-1 block">
                  <span className="text-xs font-medium text-muted-foreground">
                    Rule YAML / snippets (best input for polling decisions)
                  </span>
                  <textarea
                    className={`${INPUT_CLS} h-24 font-mono`}
                    value={rulesYaml}
                    onChange={(e) => setRulesYaml(e.target.value)}
                    spellCheck={false}
                    placeholder="Paste rule YAML so polling/rule_input align with what you run…"
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">Polling mode</span>
                    <select
                      className={INPUT_CLS}
                      value={pollingMode}
                      onChange={(e) => setPollingMode(e.target.value as typeof pollingMode)}
                    >
                      <option value="">conservative (rules drive it)</option>
                      <option value="rules_only">rules only</option>
                      <option value="rules_plus_trending">rules + approved trending</option>
                    </select>
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">
                      Model (optional override)
                    </span>
                    <input
                      className={INPUT_CLS}
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="default: server-configured"
                    />
                  </label>
                </div>
                <label className="space-y-1 block">
                  <span className="text-xs font-medium text-muted-foreground">
                    Operator brief (optional) — feeds/fed-by topology, naming conventions
                  </span>
                  <textarea
                    className={`${INPUT_CLS} h-16`}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="e.g. AHU-1 feeds VAV-1..6; zone sensors named ZN-T-*"
                  />
                </label>
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={production}
                      onChange={(e) => setProduction(e.target.checked)}
                    />
                    Live production job (conservative)
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={weather}
                      onChange={(e) => setWeather(e.target.checked)}
                    />
                    Weather rules in scope
                  </label>
                </div>

                {tagMutation.isError && (
                  <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    <span className="font-medium">Tagging failed:</span> {tagMutation.error.message}
                  </div>
                )}

                <button
                  type="button"
                  onClick={runTagging}
                  disabled={tagMutation.isPending}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {tagMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Tagging… this can take a moment for large sites
                    </>
                  ) : (
                    <>
                      <Wand2 className="h-4 w-4" />
                      Tag with AI
                    </>
                  )}
                </button>
              </div>
            )}

            {/* --- Review & correct --- */}
            {points && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-medium">
                    Proposal: {points.length} points, {equipment.length} equipment
                  </span>
                  {meta && <Badge variant="outline">model {meta.model}</Badge>}
                  {lowConfidenceCount > 0 && (
                    <Badge variant="warning">{lowConfidenceCount} low-confidence — review</Badge>
                  )}
                </div>

                {meta?.warnings.map((w, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-foreground"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    {w}
                  </div>
                ))}

                <datalist id="ai-tag-brick-classes">
                  {BRICK_CLASS_OPTIONS.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>

                {grouped.map(([eqName, rows]) => {
                  const eq = equipmentByName.get(eqName === "Unassigned" ? "" : eqName);
                  return (
                    <div key={eqName} className="rounded-lg border border-border/60">
                      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 bg-muted/40 px-3 py-2">
                        <span className="font-medium">{eqName}</span>
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          type
                          <input
                            className={`${INPUT_CLS} w-56`}
                            list="ai-tag-brick-classes"
                            value={eq?.equipment_type ?? ""}
                            onChange={(e) => updateEquipmentType(eqName, e.target.value)}
                            placeholder="Equipment"
                            disabled={eqName === "Unassigned"}
                          />
                        </label>
                        {eq && confidenceBadge(eq.confidence)}
                        {eq?.rationale && (
                          <span
                            className="text-xs text-muted-foreground"
                            title={eq.rationale}
                          >
                            ⓘ
                          </span>
                        )}
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs text-muted-foreground">
                              <th className="px-3 py-1 font-medium">Point</th>
                              <th className="px-3 py-1 font-medium">brick_type</th>
                              <th className="px-3 py-1 font-medium">rule_input</th>
                              <th className="px-3 py-1 font-medium">unit</th>
                              <th className="px-3 py-1 font-medium">poll</th>
                              <th className="px-3 py-1 font-medium">conf</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map(({ idx, p }) => (
                              <tr key={idx} className="border-t border-border/40 align-top">
                                <td className="px-3 py-1">
                                  <span title={p.rationale ?? undefined}>{pointLabel(p)}</span>
                                </td>
                                <td className="px-3 py-1">
                                  <input
                                    className={`${INPUT_CLS} min-w-48`}
                                    value={p.brick_type ?? ""}
                                    onChange={(e) =>
                                      updatePoint(idx, { brick_type: e.target.value || null })
                                    }
                                    placeholder="(untagged)"
                                  />
                                </td>
                                <td className="px-3 py-1">
                                  <input
                                    className={`${INPUT_CLS} w-28`}
                                    value={p.rule_input ?? ""}
                                    onChange={(e) =>
                                      updatePoint(idx, { rule_input: e.target.value || null })
                                    }
                                  />
                                </td>
                                <td className="px-3 py-1">
                                  <input
                                    className={`${INPUT_CLS} w-20`}
                                    value={p.unit ?? ""}
                                    onChange={(e) =>
                                      updatePoint(idx, { unit: e.target.value || null })
                                    }
                                  />
                                </td>
                                <td className="px-3 py-1 text-center">
                                  <input
                                    type="checkbox"
                                    checked={!!p.polling}
                                    onChange={(e) => updatePoint(idx, { polling: e.target.checked })}
                                  />
                                </td>
                                <td className="px-3 py-1">{confidenceBadge(p.confidence)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })}

                {importMutation.isError && (
                  <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    <span className="font-medium">Onboard failed:</span>{" "}
                    {importMutation.error.message}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={onboard}
                    disabled={importMutation.isPending}
                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                  >
                    {importMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                    Onboard {points.length} points
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPoints(null);
                      setEquipment([]);
                    }}
                    className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-muted/50 px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
                  >
                    Discard
                  </button>
                </div>
              </div>
            )}

            {importResult && (
              <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
                Onboarded — created {importResult.created ?? 0}, updated {importResult.updated ?? 0}
                {importResult.warnings?.length ? ` (${importResult.warnings.join("; ")})` : ""}.
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
