import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Loader2, Check, AlertTriangle, Wand2, Unlink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useSiteContext } from "@/contexts/site-context";
import { useAllPoints } from "@/hooks/use-sites";
import { dataModelAiTag, dataModelAiTagRun, dataModelImport } from "@/lib/crud-api";
import { BRICK_14_QUERY_CLASS_ALLOWLIST } from "@/data/brick-1.4-query-class-allowlist";
import type {
  AiTagRequest,
  AiTagRunStart,
  AiTagRunState,
  DataModelImportBody,
  DataModelImportResponse,
  TaggingProposal,
  TaggingProposalEquipment,
  TaggingProposalPoint,
} from "@/types/api";

const INPUT_CLS =
  "w-full rounded border border-border/60 bg-card px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

const BRICK_CLASS_OPTIONS = Array.from(BRICK_14_QUERY_CLASS_ALLOWLIST).sort();

const UNASSIGNED = "Unassigned";

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

  // Loose-point counter: DB points with no equipment, scoped to the selected
  // site - the candidates an auto-tag run will organise into equipment.
  const { data: dbPoints = [] } = useAllPoints();
  const scopedDbPoints = useMemo(
    () => (selectedSiteId ? dbPoints.filter((p) => p.site_id === selectedSiteId) : dbPoints),
    [dbPoints, selectedSiteId],
  );
  const loosePointCount = useMemo(
    () => scopedDbPoints.filter((p) => p.equipment_id == null).length,
    [scopedDbPoints],
  );

  // Stage 1 has no faults/units/polling inputs - just an optional brief + model.
  const [notes, setNotes] = useState("");
  const [model, setModel] = useState("");

  // Editable proposal (ephemeral - no DB write until Onboard).
  const [points, setPoints] = useState<TaggingProposalPoint[] | null>(null);
  const [equipment, setEquipment] = useState<TaggingProposalEquipment[]>([]);
  const [meta, setMeta] = useState<Pick<TaggingProposal, "warnings" | "model" | "usage" | "chunks"> | null>(null);
  const [importResult, setImportResult] = useState<DataModelImportResponse | null>(null);

  // Background run: POST starts it and returns a run id; we poll for progress and
  // the finished proposal (a full-site run runs minutes - too long to hold the
  // HTTP request open behind the SWA/ACA gateway).
  const [runId, setRunId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const tagMutation = useMutation<AiTagRunStart, Error, AiTagRequest>({
    mutationFn: dataModelAiTag,
    onSuccess: (started) => {
      setRunError(null);
      setRunId(started.run_id);
    },
  });

  const runQuery = useQuery<AiTagRunState>({
    queryKey: ["ai-tag-run", runId],
    queryFn: () => dataModelAiTagRun(runId as string),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 1500 : false),
  });

  // Resolve the run: seed the editable proposal on done, surface the message on
  // error. Seeding fetched data into local editable state is the same pattern as
  // ConfigPage's GET /config sync, hence the matching rule disable.
  /* eslint-disable react-hooks/set-state-in-effect -- seed editable proposal from the completed run */
  useEffect(() => {
    const d = runQuery.data;
    if (!runId || !d) return;
    if (d.status === "done" && d.proposal) {
      setPoints(d.proposal.points);
      setEquipment(d.proposal.equipment);
      setMeta({
        warnings: d.proposal.warnings,
        model: d.proposal.model,
        usage: d.proposal.usage,
        chunks: d.proposal.chunks,
      });
      setImportResult(null);
      setRunId(null);
    } else if (d.status === "error") {
      setRunError(d.error ?? "Tagging failed");
      setRunId(null);
    }
  }, [runQuery.data, runId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const running = tagMutation.isPending || !!runId;
  const progress = runQuery.data?.progress;
  const progressLabel =
    progress?.chunks != null && progress.chunks > 0
      ? `chunk ${progress.chunk ?? 0}/${progress.chunks}`
      : "starting…";

  const importMutation = useMutation<DataModelImportResponse, Error, DataModelImportBody>({
    mutationFn: dataModelImport,
    onSuccess: (data) => {
      setImportResult(data);
      setPoints(null);
      setEquipment([]);
      queryClient.invalidateQueries({ queryKey: ["data-model"] });
      queryClient.invalidateQueries({ queryKey: ["sites"] });
      queryClient.invalidateQueries({ queryKey: ["equipment"] });
      queryClient.invalidateQueries({ queryKey: ["points"] });
    },
  });

  function runTagging() {
    setRunError(null);
    const body: AiTagRequest = {
      site_id: selectedSiteId ?? null,
      notes: notes.trim() || null,
      model: model.trim() || null,
    };
    tagMutation.mutate(body);
  }

  function onboard() {
    if (!points) return;
    // Only onboard equipment still referenced by a point or already in the DB -
    // dropping orphans left behind by dissolve/reassign.
    const referenced = new Set(
      points.map((p) => (p.equipment_name ?? "").trim()).filter(Boolean),
    );
    const body: DataModelImportBody = {
      points: points.map(stripReview),
      equipment: equipment
        .filter(
          (e) =>
            e.equipment_id ||
            (e.equipment_name != null && referenced.has(e.equipment_name.trim())),
        )
        .map(stripReview),
    };
    importMutation.mutate(body);
  }

  // Group points by equipment for review, preserving the array index so edits
  // write back to the right row. Unassigned always sorts first.
  const grouped = useMemo(() => {
    const groups = new Map<string, { idx: number; p: TaggingProposalPoint }[]>();
    (points ?? []).forEach((p, idx) => {
      const key = (p.equipment_name && p.equipment_name.trim()) || UNASSIGNED;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ idx, p });
    });
    return Array.from(groups.entries()).sort((a, b) => {
      if (a[0] === UNASSIGNED) return -1;
      if (b[0] === UNASSIGNED) return 1;
      return a[0].localeCompare(b[0]);
    });
  }, [points]);

  // Datalist of known equipment names: AI-proposed rows plus any name currently
  // assigned to a point (so freshly reassigned names autocomplete too).
  const equipmentNames = useMemo(
    () =>
      Array.from(
        new Set(
          [
            ...equipment.map((e) => (e.equipment_name ?? "").trim()),
            ...(points ?? []).map((p) => (p.equipment_name ?? "").trim()),
          ].filter(Boolean),
        ),
      ).sort(),
    [equipment, points],
  );

  const equipmentByName = useMemo(
    () => new Map(equipment.map((e) => [(e.equipment_name ?? "").trim(), e])),
    [equipment],
  );

  const updatePoint = (idx: number, patch: Partial<TaggingProposalPoint>) =>
    setPoints((prev) => prev?.map((p, i) => (i === idx ? { ...p, ...patch } : p)) ?? prev);

  /** Reassign a point to an equipment by name. Just updates the point - the
   *  equipment row (and its type) is created lazily when the type is edited, so
   *  typing a name char-by-char doesn't spawn junk rows. */
  function assignPointEquipment(idx: number, rawName: string) {
    // Manual reassignment overrides the path grouping: clear the path-derived
    // source_ref so the importer links by the chosen name, not the old device.
    updatePoint(idx, { equipment_name: rawName.trim() || null, equipment_source_ref: null });
  }

  /** Set an equipment's type, upserting a row for a manually-created group. */
  function updateEquipmentType(name: string, equipment_type: string) {
    setEquipment((prev) => {
      if (prev.some((e) => (e.equipment_name ?? "").trim() === name)) {
        return prev.map((e) =>
          (e.equipment_name ?? "").trim() === name ? { ...e, equipment_type } : e,
        );
      }
      const siteId =
        points?.find((p) => (p.equipment_name ?? "").trim() === name)?.site_id ??
        selectedSiteId ??
        null;
      return [
        ...prev,
        { equipment_name: name, equipment_type, site_id: siteId, confidence: null, rationale: null },
      ];
    });
  }

  /** Dissolve an equipment: return its points to Unassigned and drop the row. */
  function dissolveEquipment(name: string) {
    setPoints(
      (prev) =>
        prev?.map((p) =>
          (p.equipment_name ?? "").trim() === name ? { ...p, equipment_name: null } : p,
        ) ?? prev,
    );
    setEquipment((prev) => prev.filter((e) => (e.equipment_name ?? "").trim() !== name));
  }

  const lowConfidenceCount = (points ?? []).filter(
    (p) => p.confidence != null && p.confidence < 0.5,
  ).length;
  const unassignedCount = (points ?? []).filter(
    (p) => !(p.equipment_name && p.equipment_name.trim()),
  ).length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Sparkles className="h-5 w-5" />
          AI tagging - Stage 1: structure
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
              Stage 1 organises scanned points into structured equipment and assigns Brick types to
              both - a flat, structured model. Units are metric and every point stays{" "}
              <strong>unpolled</strong>; feeds/fed-by relationships come in stage 2. Scopes to the
              site selected in the top bar
              {selectedSiteId ? "" : " (All sites)"}. Nothing is written until you click{" "}
              <strong>Onboard</strong>.
            </p>

            {/* --- Organise --- */}
            {!points && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm">
                  <Badge variant={loosePointCount > 0 ? "default" : "outline"}>
                    {loosePointCount}
                  </Badge>
                  <span className="text-muted-foreground">
                    unassigned point{loosePointCount === 1 ? "" : "s"}{" "}
                    {selectedSiteId ? "at this site" : "across all sites"} ready to auto-tag
                    {scopedDbPoints.length > 0 && ` (of ${scopedDbPoints.length} total)`}.
                    Dissolve equipment on the Points page to free more.
                  </span>
                </div>
                <label className="space-y-1 block">
                  <span className="text-xs font-medium text-muted-foreground">
                    Operator brief (optional) - equipment naming conventions, grouping hints
                  </span>
                  <textarea
                    className={`${INPUT_CLS} h-20`}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="e.g. devices named 3-FCU-* are fan coil units; ZN-T-* are zone temps"
                  />
                </label>
                <label className="space-y-1 block max-w-xs">
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

                {(tagMutation.isError || runError) && (
                  <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    <span className="font-medium">Tagging failed:</span>{" "}
                    {runError ?? tagMutation.error?.message}
                  </div>
                )}

                <button
                  type="button"
                  onClick={runTagging}
                  disabled={running}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {running ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Tagging… {progressLabel} (runs in the background; safe to wait)
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
                  {unassignedCount > 0 && (
                    <Badge variant="warning">{unassignedCount} unassigned</Badge>
                  )}
                  {lowConfidenceCount > 0 && (
                    <Badge variant="warning">{lowConfidenceCount} low-confidence</Badge>
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
                <datalist id="ai-tag-equipment-names">
                  {equipmentNames.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>

                {grouped.map(([eqName, rows]) => {
                  const isUnassigned = eqName === UNASSIGNED;
                  const eq = equipmentByName.get(eqName);
                  return (
                    <div key={eqName} className="rounded-lg border border-border/60">
                      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 bg-muted/40 px-3 py-2">
                        <span className="font-medium">
                          {eqName}
                          <span className="ml-1 text-xs text-muted-foreground">({rows.length})</span>
                        </span>
                        {!isUnassigned && (
                          <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            type
                            <input
                              className={`${INPUT_CLS} w-56`}
                              list="ai-tag-brick-classes"
                              value={eq?.equipment_type ?? ""}
                              onChange={(e) => updateEquipmentType(eqName, e.target.value)}
                              placeholder="Equipment"
                            />
                          </label>
                        )}
                        {!isUnassigned && eq && confidenceBadge(eq.confidence)}
                        {!isUnassigned && eq?.rationale && (
                          <span className="text-xs text-muted-foreground" title={eq.rationale}>
                            ⓘ
                          </span>
                        )}
                        {!isUnassigned && (
                          <button
                            type="button"
                            onClick={() => dissolveEquipment(eqName)}
                            className="ml-auto inline-flex items-center gap-1 rounded border border-border/60 bg-card px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            title="Dissolve this equipment - return its points to Unassigned"
                          >
                            <Unlink className="h-3.5 w-3.5" />
                            Dissolve
                          </button>
                        )}
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs text-muted-foreground">
                              <th className="px-3 py-1 font-medium">Point</th>
                              <th className="px-3 py-1 font-medium">brick_type</th>
                              <th className="px-3 py-1 font-medium">unit</th>
                              <th className="px-3 py-1 font-medium">equipment</th>
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
                                    className={`${INPUT_CLS} w-20`}
                                    value={p.unit ?? ""}
                                    onChange={(e) =>
                                      updatePoint(idx, { unit: e.target.value || null })
                                    }
                                    placeholder="degC"
                                  />
                                </td>
                                <td className="px-3 py-1">
                                  <input
                                    className={`${INPUT_CLS} w-40`}
                                    list="ai-tag-equipment-names"
                                    value={p.equipment_name ?? ""}
                                    onChange={(e) => assignPointEquipment(idx, e.target.value)}
                                    placeholder="(unassigned)"
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
                Onboarded - created {importResult.created ?? 0}, updated {importResult.updated ?? 0}
                {importResult.warnings?.length ? ` (${importResult.warnings.join("; ")})` : ""}.
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
