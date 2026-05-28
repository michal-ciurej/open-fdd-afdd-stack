import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Clock, Layers, Server, Eye, EyeOff, ChevronRight } from "lucide-react";
import { useSiteContext } from "@/contexts/site-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { apiFetchText } from "@/lib/api";
import { useRulesList, type RuleMeta } from "@/hooks/use-rules";
import { useFddStatus } from "@/hooks/use-fdd-status";
import { uploadRule, deleteRule, syncRuleDefinitions, triggerFddRun, updateEquipment } from "@/lib/crud-api";
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
import { timeAgo, severityVariant, isEquipmentObserved, cn } from "@/lib/utils";
import { useAllEquipment, useEquipment, useSite, useSites } from "@/hooks/use-sites";
import {
  useActiveFaults,
  useFaultDefinitions,
  useFaultSummary,
  useSiteFaults,
  useFaultCountsByEquipment,
} from "@/hooks/use-faults";
import { FaultOverTimeChart } from "@/components/dashboard/FaultOverTimeChart";
import { DateRangeSelect } from "@/components/site/DateRangeSelect";
import type { DatePreset } from "@/components/site/DateRangeSelect";
import type { FaultState, FaultDefinition, Equipment, Site } from "@/types/api";
import { isHotReloadBenchArtifact } from "@/lib/rule-files";

function FaultsTable({
  faults,
  definitions,
  equipment,
  siteMap,
}: {
  faults: FaultState[];
  definitions: FaultDefinition[];
  equipment: Equipment[];
  siteMap?: Map<string, Site>;
}) {
  const defMap = useMemo(() => new Map(definitions.map((d) => [d.fault_id, d])), [definitions]);
  const equipById = useMemo(() => new Map(equipment.map((e) => [e.id, e])), [equipment]);
  const equipByName = useMemo(() => new Map(equipment.map((e) => [e.name, e])), [equipment]);
  const siteNames = useMemo(() => new Set(siteMap ? Array.from(siteMap.values()).map((s) => s.name) : []), [siteMap]);

  function deviceLabel(fault: FaultState): string {
    const equip = equipById.get(fault.equipment_id) ?? equipByName.get(fault.equipment_id);
    const base = equip ? equip.name : (siteMap && siteNames.has(fault.equipment_id) ? `Site: ${fault.equipment_id}` : fault.equipment_id);
    if (fault.bacnet_device_id != null && fault.bacnet_device_id !== "") {
      return `${base} (device ${fault.bacnet_device_id})`;
    }
    return base;
  }

  if (faults.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center" data-testid="faults-empty-state">
        <p className="text-sm text-muted-foreground">
          No active faults{siteMap ? " across any site" : " for this site"}.
        </p>
      </div>
    );
  }

  function sensorFromContext(context: Record<string, unknown> | null | undefined): string {
    if (!context || typeof context !== "object") return "—";
    const c = context as Record<string, unknown>;
    if (typeof c.point_external_id === "string") return c.point_external_id;
    if (typeof c.external_id === "string") return c.external_id;
    if (typeof c.sensor === "string") return c.sensor;
    if (typeof c.column === "string") return c.column;
    return "—";
  }

  return (
    <Table data-testid="faults-active-table">
      <TableHeader>
        <TableRow>
          {siteMap && <TableHead>Site</TableHead>}
          <TableHead>Device</TableHead>
          <TableHead>Fault</TableHead>
          <TableHead className="text-muted-foreground">Sensor / point</TableHead>
          <TableHead>Severity</TableHead>
          <TableHead className="w-[1%] whitespace-nowrap text-muted-foreground">Plots</TableHead>
          <TableHead className="text-right">Since</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {faults.map((fault) => {
          const def = defMap.get(fault.fault_id);
          const severity = def?.severity ?? "warning";
          const sensor = sensorFromContext(fault.context);

          return (
            <TableRow key={fault.id}>
              {siteMap && (
                <TableCell className="text-muted-foreground">
                  {siteMap.get(fault.site_id)?.name ?? fault.site_id.slice(0, 8)}
                </TableCell>
              )}
              <TableCell className="font-medium">
                {deviceLabel(fault)}
              </TableCell>
              <TableCell>{def?.name ?? fault.fault_id}</TableCell>
              <TableCell className="text-muted-foreground font-mono text-xs">
                {sensor}
              </TableCell>
              <TableCell>
                <Badge variant={severityVariant(severity)}>{severity}</Badge>
              </TableCell>
              <TableCell>
                {fault.bacnet_device_id != null && fault.bacnet_device_id !== "" ? (
                  <Link
                    className="text-xs text-primary underline-offset-2 hover:underline"
                    to={`/plots?${new URLSearchParams({
                      site: fault.site_id,
                      device: fault.bacnet_device_id,
                      fault: fault.fault_id,
                    }).toString()}`}
                  >
                    Trends
                  </Link>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-right text-muted-foreground">
                {timeAgo(fault.last_changed_ts)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function AllFaultsView() {
  const { data: faults, isLoading } = useActiveFaults();
  const { data: definitions = [] } = useFaultDefinitions();
  const { data: equipment = [] } = useAllEquipment();
  const { data: sites = [] } = useSites();
  const siteMap = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);

  if (isLoading) return <Skeleton className="h-72 w-full rounded-2xl" />;

  return (
    <FaultsTable faults={faults ?? []} definitions={definitions} equipment={equipment} siteMap={siteMap} />
  );
}

function SiteFaultsView({ siteId }: { siteId: string }) {
  const { data: faults = [], isLoading } = useSiteFaults(siteId);
  const { data: definitions = [] } = useFaultDefinitions();
  const { data: equipment = [] } = useEquipment(siteId);
  const { data: site } = useSite(siteId);
  const siteMap = useMemo(
    () => (site ? new Map([[site.id, site]]) : undefined),
    [site],
  );

  if (isLoading) return <Skeleton className="h-72 w-full rounded-2xl" />;

  return (
    <FaultsTable
      faults={faults}
      definitions={definitions}
      equipment={equipment}
      siteMap={siteMap}
    />
  );
}

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
              <TableCell className="text-muted-foreground">{d.category ?? "—"}</TableCell>
              <TableCell>
                <Badge variant={severityVariant(d.severity)}>{d.severity}</Badge>
              </TableCell>
              <TableCell className="text-right text-muted-foreground text-xs">
                {d.equipment_types?.length ? d.equipment_types.join(", ") : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

type EquipmentFaultRollup = {
  equipment_id: string;
  equipment_name: string;
  equipment_type: string | null;
  site_id: string;
  total_count: number;
  faults: {
    fault_id: string;
    fault_name: string;
    fault_severity: string;
    count: number;
  }[];
};

function ObservationEyeButton({ equipment }: { equipment: Equipment | undefined }) {
  const queryClient = useQueryClient();
  const observed = isEquipmentObserved(equipment);
  const mutation = useMutation({
    mutationFn: (nextObserved: boolean) => {
      if (!equipment) throw new Error("Equipment not found");
      return updateEquipment(equipment.id, { metadata: { observed: nextObserved } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["equipment"] });
    },
  });

  return (
    <button
      type="button"
      onClick={() => mutation.mutate(!observed)}
      disabled={!equipment || mutation.isPending}
      title={
        !equipment
          ? "Equipment not loaded"
          : observed
            ? "Stop tracking this equipment on the overview page"
            : "Track fault frequency on the overview page"
      }
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-full border transition-colors",
        observed
          ? "border-warning/30 bg-warning/10 text-warning-foreground hover:bg-warning/20"
          : "border-border/60 bg-background text-muted-foreground hover:bg-muted",
        (!equipment || mutation.isPending) && "opacity-50",
      )}
      data-testid={`fault-counts-observe-${equipment?.id ?? "unknown"}`}
      aria-pressed={observed}
      aria-label={observed ? "Stop observing" : "Mark for observation"}
    >
      {observed ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
    </button>
  );
}

function FaultCountsByEquipmentSection({
  siteId,
  startDate,
  endDate,
}: {
  siteId: string | undefined;
  startDate: string;
  endDate: string;
}) {
  const { data, isLoading, error } = useFaultCountsByEquipment(
    siteId,
    startDate,
    endDate,
  );
  const { data: equipmentAll = [] } = useAllEquipment();
  const { data: equipmentSite = [] } = useEquipment(siteId);
  const equipment = siteId ? equipmentSite : equipmentAll;
  const equipById = useMemo(
    () => new Map(equipment.map((e) => [e.id, e])),
    [equipment],
  );

  const rollups: EquipmentFaultRollup[] = useMemo(() => {
    const rows = data?.rows ?? [];
    const acc = new Map<string, EquipmentFaultRollup>();
    for (const r of rows) {
      let entry = acc.get(r.equipment_id);
      if (!entry) {
        entry = {
          equipment_id: r.equipment_id,
          equipment_name: r.equipment_name,
          equipment_type: r.equipment_type,
          site_id: r.site_id,
          total_count: 0,
          faults: [],
        };
        acc.set(r.equipment_id, entry);
      }
      entry.total_count += r.count;
      entry.faults.push({
        fault_id: r.fault_id,
        fault_name: r.fault_name,
        fault_severity: r.fault_severity,
        count: r.count,
      });
    }
    const list = Array.from(acc.values());
    for (const e of list) e.faults.sort((a, b) => b.count - a.count);
    list.sort((a, b) => b.total_count - a.total_count);
    return list;
  }, [data]);

  if (isLoading) return <Skeleton className="h-40 w-full rounded-xl" />;
  if (error) {
    return (
      <div className="mb-8 text-sm text-destructive">
        Could not load per-equipment fault counts.
      </div>
    );
  }
  if (rollups.length === 0) {
    return (
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">
          Fault counts by equipment
        </h2>
        <div className="rounded-xl border border-border/70 bg-muted/40 p-6 text-sm text-muted-foreground">
          No fault rows in this time range.
        </div>
      </section>
    );
  }

  return (
    <section className="mb-8">
      <h2 className="mb-1 text-sm font-medium text-muted-foreground">
        Fault counts by equipment
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Ranked by total fault count — highest first. Mark equipment for
        observation to surface it on the overview page.
      </p>
      <Table data-testid="fault-counts-by-equipment-table">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[1%] whitespace-nowrap text-muted-foreground">#</TableHead>
            <TableHead>Equipment</TableHead>
            <TableHead>Faults</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead className="w-[1%] whitespace-nowrap text-right">Observe</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rollups.map((row, idx) => {
            const equip = equipById.get(row.equipment_id);
            return (
              <TableRow
                key={row.equipment_id}
                data-testid={`fault-counts-row-${row.equipment_id}`}
              >
                <TableCell className="text-muted-foreground tabular-nums">
                  {idx + 1}
                </TableCell>
                <TableCell>
                  <Link
                    to={`/equipment/${row.equipment_id}`}
                    className="font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {row.equipment_name}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {row.equipment_type ?? "—"}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1.5">
                    {row.faults.map((f) => (
                      <Badge
                        key={f.fault_id}
                        variant={severityVariant(f.fault_severity)}
                        title={`${f.fault_name} · severity ${f.fault_severity}`}
                      >
                        {f.fault_name}
                        <span className="ml-1.5 tabular-nums opacity-80">
                          {f.count}
                        </span>
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono font-medium tabular-nums">
                  {row.total_count}
                </TableCell>
                <TableCell className="text-right">
                  <ObservationEyeButton equipment={equip} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function formatLocalDT(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

function presetRange(preset: DatePreset): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  switch (preset) {
    case "24h":
      start.setHours(start.getHours() - 24);
      break;
    case "7d":
      start.setDate(start.getDate() - 7);
      break;
    case "30d":
      start.setDate(start.getDate() - 30);
      break;
    default:
      start.setDate(start.getDate() - 7);
  }
  return { start: start.toISOString(), end: end.toISOString() };
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

function labelForPreset(preset: DatePreset): string {
  switch (preset) {
    case "24h":
      return "last 24 h";
    case "7d":
      return "last 7 d";
    case "30d":
      return "last 30 d";
    case "custom":
    default:
      return "custom range";
  }
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

function FddLoopStatusSection({ siteId }: { siteId: string | undefined }) {
  const queryClient = useQueryClient();
  const { data: status, isLoading: statusLoading } = useFddStatus();
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

  const triggerMutation = useMutation({
    mutationFn: triggerFddRun,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fdd-status"] });
    },
  });

  const lastRun = status?.last_run ?? null;
  const statusVariant = lastRun?.status === "ok" ? "success" : lastRun?.status ? "destructive" : "outline";

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
                onClick={() => triggerMutation.mutate()}
                disabled={triggerMutation.isPending}
                data-testid="fdd-run-now-button"
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                title="POST /run-fdd — touches trigger file; loop picks it up within 60s"
              >
                <Play className="h-4 w-4" />
                {triggerMutation.isPending ? "Triggering…" : "Run FDD now"}
              </button>
              {triggerMutation.isSuccess && (
                <span className="text-xs text-muted-foreground">
                  Triggered. Loop will pick up within ~60s.
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

export function FaultsPage() {
  const { selectedSiteId } = useSiteContext();
  const [preset, setPreset] = useState<DatePreset>("7d");
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [customStart, setCustomStart] = useState(formatLocalDT(weekAgo));
  const [customEnd, setCustomEnd] = useState(formatLocalDT(now));

  const { start, end } = useMemo(() => {
    if (preset === "custom") {
      return {
        start: new Date(customStart).toISOString(),
        end: new Date(customEnd).toISOString(),
      };
    }
    return presetRange(preset);
  }, [preset, customStart, customEnd]);

  const bucket: "hour" | "day" = preset === "24h" ? "hour" : "day";
  const { data: definitions = [] } = useFaultDefinitions();
  const { data: summary } = useFaultSummary(
    selectedSiteId ?? undefined,
    start,
    end,
  );
  const periodLabel = labelForPreset(preset);

  return (
    <div className="flex flex-col">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">Faults</h1>

      <FddLoopStatusSection siteId={selectedSiteId ?? undefined} />

      {/* Time range bar at top: all summary and charts below use this range */}
      <header className="mb-6 flex flex-wrap items-center gap-4 rounded-xl border border-border/80 bg-muted/70 px-4 py-3 shadow-sm">
        <span className="text-sm font-semibold text-foreground">Time range</span>
        <DateRangeSelect
          preset={preset}
          onPresetChange={setPreset}
          customStart={customStart}
          customEnd={customEnd}
          onCustomStartChange={setCustomStart}
          onCustomEndChange={setCustomEnd}
        />
        <span className="font-mono text-sm text-muted-foreground tabular-nums">
          {start.slice(0, 10)} → {end.slice(0, 10)}
        </span>
      </header>

      {summary != null && (
        <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">Active faults in period ({periodLabel})</p>
              <p
                className={`mt-1 text-3xl font-semibold tabular-nums ${
                  (summary.active_in_period ?? summary.total_faults ?? 0) > 0
                    ? "text-destructive"
                    : "text-muted-foreground"
                }`}
              >
                {summary.active_in_period ?? summary.total_faults ?? 0}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Distinct (site + device + fault) in range. From FDD rule runs (fault_results).
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">Fault flags over time</h2>
        <FaultOverTimeChart
          siteId={selectedSiteId ?? undefined}
          definitions={definitions}
          preset={preset}
          start={start}
          end={end}
          bucket={bucket}
        />
      </section>

      <FaultCountsByEquipmentSection
        siteId={selectedSiteId ?? undefined}
        startDate={start}
        endDate={end}
      />
      <FaultDefinitionsSection />
      <RuleFilesSection />

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">Active fault rows (current state)</h2>
        {selectedSiteId ? <SiteFaultsView siteId={selectedSiteId} /> : <AllFaultsView />}
      </section>
    </div>
  );
}
