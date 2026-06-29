import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Clock, Layers, Server, ChevronRight } from "lucide-react";
import { useSiteContext } from "@/contexts/site-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { apiFetchText } from "@/lib/api";
import { useRulesList, type RuleMeta } from "@/hooks/use-rules";
import { useFddStatus } from "@/hooks/use-fdd-status";
import { uploadRule, deleteRule, syncRuleDefinitions, triggerFddRun } from "@/lib/crud-api";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import { JsonPrettyPanel } from "@/components/ui/json-pretty-panel";
import { timeAgo, severityVariant, cn } from "@/lib/utils";
import { useAllEquipment, useEquipment } from "@/hooks/use-sites";
import { useFaultDefinitions } from "@/hooks/use-faults";
import { isHotReloadBenchArtifact } from "@/lib/rule-files";

function FaultDefinitionsSection() {
  const { data: definitions = [], isLoading } = useFaultDefinitions();

  if (isLoading) return <Skeleton className="h-32 w-full rounded-xl" />;
  if (definitions.length === 0) return null;

  return (
    <div className="mb-8">
      <h2 className="mb-3 text-sm font-medium text-muted-foreground">
        Fault definitions ({definitions.length})
      </h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Fault ID</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Severity</TableHead>
            <TableHead className="text-right">Target equipment</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {definitions.map((d) => (
            <TableRow key={d.fault_id}>
              <TableCell className="font-mono text-xs">{d.fault_id}</TableCell>
              <TableCell className="font-medium">{d.name}</TableCell>
              <TableCell className="text-muted-foreground">{d.category ?? "-"}</TableCell>
              <TableCell>
                <Badge variant={severityVariant(d.severity)}>{d.severity}</Badge>
              </TableCell>
              <TableCell className="text-right text-muted-foreground text-xs">
                {d.equipment_types?.length ? d.equipment_types.join(", ") : "-"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function RuleFileContentPreview({ content }: { content: string }) {
  const t = content.trim();
  let parsedJson: unknown | null = null;
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      parsedJson = JSON.parse(t) as unknown;
    } catch {
      parsedJson = null;
    }
  }
  if (parsedJson !== null) {
    return <JsonPrettyPanel value={parsedJson} maxHeightClass="max-h-96" defaultExpandDepth={2} />;
  }
  return (
    <pre className="max-h-96 overflow-auto rounded-md border border-border/60 bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap break-all text-foreground">
      {content}
    </pre>
  );
}

const EQUIP_UNSPECIFIED = "Unspecified";

function prettyEquipType(key: string): string {
  if (key === EQUIP_UNSPECIFIED) return "Unspecified / all equipment";
  return key.replace(/_/g, " ");
}

type RuleGroup = { key: string; label: string; rules: RuleMeta[] };

function RuleFilesSection() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useRulesList();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploadFilename, setUploadFilename] = useState("");
  const [uploadContent, setUploadContent] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  const { groups, benchRules, primaryCount, rulesDir } = useMemo(() => {
    const files = data?.files ?? [];
    const ruleMetas: RuleMeta[] = data?.rules?.length
      ? data.rules
      : files.map((f) => ({
          filename: f,
          name: null,
          equipment_types: [],
          category: null,
          severity: null,
          description: null,
        }));
    const primary = ruleMetas.filter((r) => !isHotReloadBenchArtifact(r.filename));
    const bench = ruleMetas.filter((r) => isHotReloadBenchArtifact(r.filename));

    const acc = new Map<string, RuleMeta[]>();
    for (const r of primary) {
      const key = r.equipment_types[0] ?? EQUIP_UNSPECIFIED;
      const arr = acc.get(key);
      if (arr) arr.push(r);
      else acc.set(key, [r]);
    }
    const grouped: RuleGroup[] = Array.from(acc.entries()).map(([key, rules]) => ({
      key,
      label: prettyEquipType(key),
      rules: rules.slice().sort((a, b) => a.filename.localeCompare(b.filename)),
    }));
    grouped.sort((a, b) => {
      // "Unspecified" sinks to the bottom; everything else alphabetical.
      const au = a.key === EQUIP_UNSPECIFIED ? 1 : 0;
      const bu = b.key === EQUIP_UNSPECIFIED ? 1 : 0;
      if (au !== bu) return au - bu;
      return a.label.localeCompare(b.label);
    });

    return {
      groups: grouped,
      benchRules: bench,
      primaryCount: primary.length,
      rulesDir: data?.rules_dir ?? "",
    };
  }, [data]);

  const toggleGroup = useCallback((key: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const expandAll = useCallback(
    () => setOpenGroups(new Set(groups.map((g) => g.key))),
    [groups],
  );
  const collapseAll = useCallback(() => setOpenGroups(new Set()), []);

  const openFile = useCallback((filename: string) => {
    setSelectedFile(filename);
    setFileContent(null);
    setFileError(null);
    setFileLoading(true);
    apiFetchText(`/rules/${encodeURIComponent(filename)}`)
      .then(setFileContent)
      .catch((e: Error) => setFileError(e.message))
      .finally(() => setFileLoading(false));
  }, []);

  const uploadMutation = useMutation({
    mutationFn: () => uploadRule(uploadFilename.trim() || "rule.yaml", uploadContent),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["rules"] });
      queryClient.invalidateQueries({ queryKey: ["faults"] });
      setUploadFilename("");
      setUploadContent("");
      setUploadError(null);
      if (data?.filename) openFile(data.filename);
    },
    onError: (e: Error) => setUploadError(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (filename: string) => deleteRule(filename),
    onSuccess: (_, filename) => {
      queryClient.invalidateQueries({ queryKey: ["rules"] });
      queryClient.invalidateQueries({ queryKey: ["faults"] });
      if (selectedFile === filename) {
        setSelectedFile(null);
        setFileContent(null);
      }
    },
  });

  const syncMutation = useMutation({
    mutationFn: syncRuleDefinitions,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["faults"] }),
  });

  const handleUpload = (e: React.FormEvent) => {
    e.preventDefault();
    setUploadError(null);
    const fn = uploadFilename.trim();
    if (!fn.endsWith(".yaml")) {
      setUploadError("Filename must end with .yaml");
      return;
    }
    uploadMutation.mutate();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const name = file.name.endsWith(".yaml") ? file.name : `${file.name}.yaml`;
    setUploadFilename(name);
    const reader = new FileReader();
    reader.onload = () => setUploadContent(String(reader.result ?? ""));
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleDownload = useCallback((filename: string) => {
    apiFetchText(`/rules/${encodeURIComponent(filename)}`)
      .then((text) => {
        const blob = new Blob([text], { type: "application/x-yaml" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch((err: Error) => setFileError(err.message));
  }, []);

  const handleDelete = (filename: string) => {
    if (!window.confirm(`Remove rule file "${filename}"? Definition will be removed after next FDD run or Sync.`)) return;
    deleteMutation.mutate(filename);
  };

  const renderRuleRow = (rule: RuleMeta) => {
    const isSelected = selectedFile === rule.filename;
    return (
      <div
        key={rule.filename}
        className={cn(
          "flex flex-wrap items-center gap-2 px-3 py-2 text-sm",
          isSelected && "bg-primary/5",
        )}
        data-testid={`rule-row-${rule.filename}`}
      >
        <button
          type="button"
          onClick={() => openFile(rule.filename)}
          className={cn(
            "text-left font-medium transition-colors",
            isSelected ? "text-primary underline" : "hover:text-primary",
          )}
          title={rule.description ?? undefined}
        >
          {rule.name ?? rule.filename}
        </button>
        <span className="font-mono text-xs text-muted-foreground">{rule.filename}</span>
        {rule.category && (
          <Badge variant="outline" className="text-xs">
            {rule.category}
          </Badge>
        )}
        {rule.severity && (
          <Badge variant={severityVariant(rule.severity)} className="text-xs">
            {rule.severity}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="h-6 px-1.5 text-xs hover:text-primary"
            onClick={() => handleDownload(rule.filename)}
            title="Download"
          >
            ↓
          </button>
          <button
            type="button"
            className="h-6 px-1.5 text-xs text-destructive hover:text-destructive"
            onClick={() => handleDelete(rule.filename)}
            title="Delete"
          >
            ×
          </button>
        </div>
      </div>
    );
  };

  if (isLoading) return <Skeleton className="h-40 w-full rounded-xl" />;
  const hasRules = primaryCount > 0 || benchRules.length > 0;

  return (
    <div className="mb-8">
      <h2 className="mb-3 text-sm font-medium text-muted-foreground">
        Rules Repository
      </h2>
      <p className="mb-2 text-xs text-muted-foreground">
        These rules are our storage of rule fault definitions, we can write new rules, check existing ones, then when our updated collection of rules is ready we can Sync them into the fault engine
      </p>
      <Card>
        <CardContent className="pt-4">
          {data?.error && (
            <p className="mb-3 text-sm text-destructive">{data.error}</p>
          )}
          {rulesDir && (
            <p className="mb-3 font-mono text-xs text-muted-foreground">
              {rulesDir}
            </p>
          )}

          {/* Upload */}
          <form onSubmit={handleUpload} className="mb-4 space-y-2">
            <div className="flex flex-wrap items-end gap-2">
              <input
                type="text"
                placeholder="filename.yaml"
                value={uploadFilename}
                onChange={(e) => setUploadFilename(e.target.value)}
                className="rounded-md border border-input bg-background px-3 py-1.5 font-mono text-sm"
              />
              <label className="cursor-pointer">
                <span className="inline-flex items-center rounded-md border border-input bg-muted px-3 py-1.5 text-sm hover:bg-muted/80">Choose file</span>
                <input type="file" accept=".yaml,.yml" className="sr-only" onChange={handleFileSelect} />
              </label>
              <button
                type="submit"
                disabled={uploadMutation.isPending || !uploadContent.trim()}
                className="rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-muted"
              >
                {uploadMutation.isPending ? "Uploading…" : "Upload"}
              </button>
              <button
                type="button"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                className="rounded-md border border-input bg-muted/50 px-3 py-1.5 text-sm hover:bg-muted"
              >
                {syncMutation.isPending ? "Syncing…" : "Sync definitions"}
              </button>
            </div>
            <textarea
              placeholder="Paste YAML or use Choose file…"
              value={uploadContent}
              onChange={(e) => setUploadContent(e.target.value)}
              rows={6}
              className="w-full rounded-md border border-input bg-muted/30 p-2 font-mono text-xs"
            />
            {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}
          </form>

          {!hasRules && !data?.error ? (
            <p className="text-sm text-muted-foreground">No .yaml files in rules_dir.</p>
          ) : (
            <div className="space-y-2">
              {/* Group controls */}
              <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
                <p className="text-xs text-muted-foreground">
                  {primaryCount} {primaryCount === 1 ? "rule" : "rules"} across{" "}
                  {groups.length} equipment{" "}
                  {groups.length === 1 ? "type" : "types"}
                </p>
                {groups.length > 0 && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={expandAll}
                      className="rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-muted"
                    >
                      Expand all
                    </button>
                    <button
                      type="button"
                      onClick={collapseAll}
                      className="rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-muted"
                    >
                      Collapse all
                    </button>
                  </div>
                )}
              </div>

              {/* Accordions by equipment type */}
              {groups.map((g) => {
                const isOpen = openGroups.has(g.key);
                return (
                  <div
                    key={g.key}
                    className="overflow-hidden rounded-lg border border-border/70"
                  >
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.key)}
                      aria-expanded={isOpen}
                      data-testid={`rule-group-${g.key}`}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/50"
                    >
                      <ChevronRight
                        className={cn(
                          "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                          isOpen && "rotate-90",
                        )}
                      />
                      <span className="font-medium">{g.label}</span>
                      <Badge variant="outline" className="ml-1 tabular-nums">
                        {g.rules.length}
                      </Badge>
                    </button>
                    {isOpen && (
                      <div className="divide-y divide-border/50 border-t border-border/70">
                        {g.rules.map(renderRuleRow)}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Bench / E2E artifacts */}
              {benchRules.length > 0 && (
                <div className="overflow-hidden rounded-lg border border-amber-500/30 bg-amber-500/5">
                  <button
                    type="button"
                    onClick={() => toggleGroup("__bench__")}
                    aria-expanded={openGroups.has("__bench__")}
                    data-testid="rule-group-bench"
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-amber-500/10"
                  >
                    <ChevronRight
                      className={cn(
                        "h-4 w-4 shrink-0 text-amber-700 transition-transform dark:text-amber-300",
                        openGroups.has("__bench__") && "rotate-90",
                      )}
                    />
                    <span className="font-medium text-amber-800 dark:text-amber-200">
                      Bench / E2E rule copies
                    </span>
                    <Badge variant="outline" className="ml-1 tabular-nums">
                      {benchRules.length}
                    </Badge>
                  </button>
                  {openGroups.has("__bench__") && (
                    <div className="divide-y divide-amber-500/20 border-t border-amber-500/30">
                      {benchRules.map(renderRuleRow)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {selectedFile && (
            <div className="mt-4 border-t pt-4">
              <p className="mb-2 font-mono text-xs text-muted-foreground">
                {selectedFile}
              </p>
              {fileLoading && (
                <Skeleton className="h-48 w-full rounded-md" />
              )}
              {fileError && (
                <p className="text-sm text-destructive">{fileError}</p>
              )}
              {fileContent != null && !fileLoading && (
                <RuleFileContentPreview content={fileContent} />
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// A manual run is ~1-2 min; if no fresh run_ts lands after this we stop the
// spinner and tell the user to check the Faults page (prevents a stuck UI).
const RUN_TIMEOUT_MS = 180_000;

type RunResult =
  | { kind: "success"; faults: number }
  | { kind: "error"; status: string }
  | { kind: "timeout" };

function FddLoopStatusSection({ siteId }: { siteId: string | undefined }) {
  const queryClient = useQueryClient();
  // While a manual run is in flight, poll the DB-backed status endpoint fast so
  // we notice the new fdd_run_log row promptly; idle back to 60s otherwise.
  const [isRunning, setIsRunning] = useState(false);
  const [baselineRunTs, setBaselineRunTs] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const { data: status, isLoading: statusLoading } = useFddStatus(
    isRunning ? 4_000 : 60_000,
  );
  const { data: rulesList } = useRulesList();
  const { data: equipmentAll = [] } = useAllEquipment();
  const { data: equipmentSite = [] } = useEquipment(siteId);
  const equipment = siteId ? equipmentSite : equipmentAll;

  const ruleCount = useMemo(() => {
    const files = rulesList?.files ?? [];
    return files.filter((f) => !isHotReloadBenchArtifact(f)).length;
  }, [rulesList]);

  const equipmentCount = equipment.length;
  const evaluationsPerRun = ruleCount * equipmentCount;

  const lastRun = status?.last_run ?? null;
  const statusVariant = lastRun?.status === "ok" ? "success" : lastRun?.status ? "destructive" : "outline";

  // Fire-and-forget the in-process job. The returned job_id is for telemetry
  // only; completion is detected off the DB-backed status below, not the
  // per-replica in-memory job store (the API may run >1 replica).
  const triggerMutation = useMutation({
    mutationFn: triggerFddRun,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fdd-status"] });
    },
    onError: () => setIsRunning(false),
  });

  const handleTrigger = useCallback(() => {
    setRunResult(null);
    setBaselineRunTs(lastRun?.run_ts ?? null);
    setIsRunning(true);
    triggerMutation.mutate();
  }, [lastRun?.run_ts, triggerMutation]);

  // Completion: a run_ts strictly newer than the one captured at trigger time
  // means a fresh fdd_run_log row landed (status ok or error).
  useEffect(() => {
    if (!isRunning || !lastRun?.run_ts) return;
    const isNewer =
      baselineRunTs == null ||
      new Date(lastRun.run_ts).getTime() > new Date(baselineRunTs).getTime();
    if (!isNewer) return;
    // Transitioning local UI state in response to freshly-polled server data is
    // the intended use of an effect here; the lint rule flags it as a false positive.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsRunning(false);
    setRunResult(
      lastRun.status === "ok"
        ? { kind: "success", faults: lastRun.faults_written }
        : { kind: "error", status: lastRun.status },
    );
    queryClient.invalidateQueries({ queryKey: ["faults"] });
    queryClient.invalidateQueries({ queryKey: ["analytics"] });
  }, [isRunning, lastRun, baselineRunTs, queryClient]);

  // Timeout guard so the spinner never gets stuck if no fresh run_ts arrives.
  useEffect(() => {
    if (!isRunning) return;
    const t = setTimeout(() => {
      setIsRunning(false);
      setRunResult({ kind: "timeout" });
    }, RUN_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [isRunning]);

  const triggerDisabled = triggerMutation.isPending || isRunning;

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-medium text-muted-foreground">FDD loop</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Last run + manual trigger */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  Last FDD run
                </p>
                {statusLoading ? (
                  <Skeleton className="mt-2 h-7 w-32" />
                ) : lastRun ? (
                  <>
                    <p className="mt-1 text-lg font-semibold tabular-nums" title={lastRun.run_ts}>
                      {timeAgo(lastRun.run_ts)}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant={statusVariant}>{lastRun.status}</Badge>
                      <span>sites: <span className="font-mono tabular-nums">{lastRun.sites_processed}</span></span>
                      <span>faults written: <span className="font-mono tabular-nums">{lastRun.faults_written}</span></span>
                    </div>
                  </>
                ) : (
                  <p className="mt-1 text-sm text-muted-foreground">No runs recorded yet.</p>
                )}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleTrigger}
                disabled={triggerDisabled}
                data-testid="fdd-run-now-button"
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                title="POST /jobs/fdd/run — runs FDD now in the API container"
              >
                <Play className="h-4 w-4" />
                {triggerMutation.isPending
                  ? "Triggering…"
                  : isRunning
                    ? "Running…"
                    : "Run FDD now"}
              </button>
              {isRunning && (
                <span className="text-xs text-muted-foreground">
                  Running in the API container… waiting for the run to complete.
                </span>
              )}
              {!isRunning && runResult?.kind === "success" && (
                <span className="text-xs text-muted-foreground">
                  Run complete — {runResult.faults} fault{" "}
                  {runResult.faults === 1 ? "row" : "rows"} written.
                </span>
              )}
              {!isRunning && runResult?.kind === "error" && (
                <Badge variant="destructive">Run failed: {runResult.status}</Badge>
              )}
              {!isRunning && runResult?.kind === "timeout" && (
                <span className="text-xs text-muted-foreground">
                  Run started; status not yet confirmed — check the Faults page.
                </span>
              )}
              {triggerMutation.isError && (
                <span className="text-xs text-destructive">
                  {(triggerMutation.error as Error)?.message ?? "Trigger failed"}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Rules loaded */}
        <Card>
          <CardContent className="pt-6">
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Layers className="h-4 w-4" />
              Rules loaded
            </p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{ruleCount}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              YAML files in rules_dir (bench artifacts excluded). Each FDD run hot-reloads from disk.
            </p>
          </CardContent>
        </Card>

        {/* Equipment in scope + estimated evaluations */}
        <Card>
          <CardContent className="pt-6">
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Server className="h-4 w-4" />
              Equipment in scope {siteId ? "(this site)" : "(all sites)"}
            </p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{equipmentCount}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              ≈ <span className="font-mono tabular-nums">{evaluationsPerRun}</span> rule × equipment evaluations per run
              (rules apply only to matching equipment_type, so actual count is lower).
            </p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

export function FddRulesPage() {
  const { selectedSiteId } = useSiteContext();

  return (
    <div className="flex flex-col">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">FDD &amp; Rules</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Fault-detection engine administration: trigger a run, manage the rule repository, and review the
        loaded fault definitions. Operators see the resulting faults on the <strong>Faults</strong> page.
      </p>

      <FddLoopStatusSection siteId={selectedSiteId ?? undefined} />
      <FaultDefinitionsSection />
      <RuleFilesSection />
    </div>
  );
}
