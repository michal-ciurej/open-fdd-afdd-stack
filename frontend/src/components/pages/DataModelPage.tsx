import { useState, useCallback, useMemo, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Database, Upload, Server, Save, RotateCcw, Search, Trash2, Download, FileText, FileUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { JsonPrettyPanel } from "@/components/ui/json-pretty-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { useSiteContext } from "@/contexts/site-context";
import { useAllEquipment, useAllPoints, useEquipment, usePoints, useSites } from "@/hooks/use-sites";
import { useActiveFaults, useSiteFaults } from "@/hooks/use-faults";
import { EquipmentTable } from "@/components/site/EquipmentTable";
import { AiTaggingPanel } from "@/components/site/AiTaggingPanel";
import { BuildingQueriesCard } from "@/components/site/BuildingQueriesCard";
import { useCapabilities } from "@/hooks/use-system";
import { apiFetch, apiFetchText } from "@/lib/api";
import { writeTtlToPopup } from "@/lib/ttl-popup";
import {
  deleteSite,
  deleteEmptyEquipment,
  dataModelSerialize,
  dataModelReset,
  dataModelCheck,
  resetFaultHistory,
  type DataModelCheckResponse,
  type ResetFaultHistoryResponse,
} from "@/lib/crud-api";
import type {
  DataModelExportRow,
  DataModelImportBody,
  DataModelImportResponse,
  StructuredDataModelExport,
} from "@/types/api";

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function DataModelPage() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const { selectedSiteId } = useSiteContext();
  const [importJson, setImportJson] = useState("");
  const [importResult, setImportResult] = useState<DataModelImportResponse | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<DataModelCheckResponse | null>(null);
  const [resetConfirm, setResetConfirm] = useState("");
  const [deleteAllConfirm, setDeleteAllConfirm] = useState("");
  const [resetFaultsConfirm, setResetFaultsConfirm] = useState("");
  const [ttlLoading, setTtlLoading] = useState(false);
  const [ttlError, setTtlError] = useState<string | null>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);
  const { data: equipmentAll = [], isLoading: equipmentAllLoading } = useAllEquipment();
  const { data: equipmentSite = [], isLoading: equipmentSiteLoading } = useEquipment(selectedSiteId ?? undefined);
  const { data: pointsAll = [] } = useAllPoints();
  const { data: pointsSite = [] } = usePoints(selectedSiteId ?? undefined);
  const { data: faultsAll = [] } = useActiveFaults();
  const { data: faultsSite = [] } = useSiteFaults(selectedSiteId ?? undefined);
  const { data: sites = [] } = useSites();
  const { data: capabilities } = useCapabilities();
  const equipment = selectedSiteId ? equipmentSite : equipmentAll;
  const points = selectedSiteId ? pointsSite : pointsAll;
  const faults = selectedSiteId ? faultsSite : faultsAll;
  const equipmentLoading = selectedSiteId ? equipmentSiteLoading : equipmentAllLoading;
  const siteMap = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites]);
  // Estimate of equipment with no points, from data already loaded on the page.
  // The backend re-checks authoritatively on delete, so this is a UI hint only -
  // in the all-sites view `points` is capped at the API default, so this may
  // over-count; it never causes a non-empty equipment to be deleted.
  const emptyEquipment = useMemo(() => {
    const withPoints = new Set(
      points.map((p) => p.equipment_id).filter((id): id is string => id != null),
    );
    return equipment.filter((e) => !withPoints.has(e.id));
  }, [equipment, points]);
  const exportQueryKey = ["data-model", "export", "structured", selectedSiteId ?? "all"] as const;
  const { data: exportData, isLoading: exportLoading } = useQuery<StructuredDataModelExport>({
    queryKey: exportQueryKey,
    queryFn: () => {
      // shape=structured returns { equipment, points } so a tag pass can set both
      // equipment_type (per equipment) and brick_type/rule_input (per point), and
      // the file PUTs straight back into /data-model/import unchanged.
      const params = new URLSearchParams({ shape: "structured" });
      if (selectedSiteId) params.set("site_id", selectedSiteId);
      return apiFetch<StructuredDataModelExport>(`/data-model/export?${params.toString()}`);
    },
    staleTime: 60 * 1000,
  });

  const importMutation = useMutation<DataModelImportResponse, Error, DataModelImportBody>({
    mutationFn: (body) =>
      apiFetch<DataModelImportResponse>("/data-model/import", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      setImportError(null);
      setImportResult(data);
      queryClient.invalidateQueries({ queryKey: ["data-model"] });
      queryClient.invalidateQueries({ queryKey: ["sites"] });
      queryClient.invalidateQueries({ queryKey: ["faults"] });
    },
    onError: (err: Error) => {
      setImportError(err.message);
      setImportResult(null);
    },
  });

  const serializeMutation = useMutation({
    mutationFn: dataModelSerialize,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["data-model"] });
    },
  });

  const resetMutation = useMutation({
    mutationFn: dataModelReset,
    onSuccess: () => {
      setResetConfirm("");
      queryClient.invalidateQueries({ queryKey: ["data-model"] });
      queryClient.invalidateQueries({ queryKey: ["sites"] });
      queryClient.invalidateQueries({ queryKey: ["equipment"] });
      queryClient.invalidateQueries({ queryKey: ["points"] });
      queryClient.invalidateQueries({ queryKey: ["faults"] });
    },
  });

  const resetFaultsMutation = useMutation<ResetFaultHistoryResponse, Error, string>({
    mutationFn: (siteId) => resetFaultHistory(siteId),
    onSuccess: () => {
      setResetFaultsConfirm("");
      queryClient.invalidateQueries({ queryKey: ["faults"] });
    },
  });

  const deleteEmptyEquipmentMutation = useMutation<
    { status: string; deleted: number; names: string[] },
    Error,
    string | undefined
  >({
    mutationFn: (siteId) => deleteEmptyEquipment(siteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["equipment"] });
      queryClient.invalidateQueries({ queryKey: ["points"] });
      queryClient.invalidateQueries({ queryKey: ["data-model"] });
    },
  });

  const checkMutation = useMutation({
    mutationFn: dataModelCheck,
    onSuccess: (data: DataModelCheckResponse | undefined) => setCheckResult(data ?? null),
  });

  const exportJson = exportData == null ? "" : JSON.stringify(exportData, null, 2);

  const handleImport = () => {
    try {
      const parsed = JSON.parse(importJson) as DataModelImportBody | DataModelExportRow[];
      const body: DataModelImportBody = Array.isArray(parsed) ? { points: parsed } : parsed;
      // Normalize: points is required by the API but may be empty for an
      // equipment-only payload (e.g. retyping equipment via equipment[]).
      const finalBody: DataModelImportBody = {
        points: body.points ?? [],
        equipment: body.equipment ?? [],
      };
      if (!finalBody.points.length && !finalBody.equipment?.length) {
        setImportError(null);
        setImportResult({ total: 0, warnings: ["No points or equipment in payload"] });
        return;
      }
      setImportError(null);
      importMutation.mutate(finalBody);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "Invalid JSON");
      setImportResult(null);
    }
  };

  const handleViewTtl = useCallback(async () => {
    setTtlError(null);
    setTtlLoading(true);
    const ttlPath = "/data-model/ttl?save=false";
    const popup = window.open("", "_blank");
    if (!popup) {
      setTtlError("Popup blocked. Allow popups for this site and try again.");
      setTtlLoading(false);
      return;
    }
    popup.document.write(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Data model TTL</title></head><body style="font-family:ui-sans-serif,system-ui,sans-serif;padding:1rem;"><p style="margin:0 0 .75rem 0;">Loading TTL graph...</p><p style="margin:0;color:#666;">If this takes too long, <a href="${ttlPath}" target="_self" rel="noopener">open raw TTL directly</a>.</p></body></html>`,
    );
    popup.document.close();
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 45000);
      const ttl = await apiFetchText(ttlPath, {
        headers: { Accept: "text/plain" },
        signal: controller.signal,
      });
      window.clearTimeout(timer);
      writeTtlToPopup(popup, ttl);
    } catch (err) {
      try {
        popup.location.href = ttlPath;
      } catch {
        popup.close?.();
      }
      setTtlError(
        err instanceof Error
          ? `Failed to load TTL in-app: ${err.message}`
          : "Failed to load TTL",
      );
    } finally {
      setTtlLoading(false);
    }
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Data Model BRICK</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Build your Brick + BACnet data model from here: export JSON for AI tagging, import tagged points, browse equipment, and
        run SPARQL. On{" "}
        <Link
          to={{ pathname: "/site-configuration", search: location.search }}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Site Configuration
        </Link>
        , create a <strong>site</strong> (Step 1) and run <strong>discovery</strong> (Step 2) before you rely on export/import.
      </p>

      {sites.length === 0 && (
        <p className="mb-6 text-sm text-muted-foreground" data-testid="data-model-no-sites-banner">
          No sites in the model yet. Create one on{" "}
          <Link
            to={{ pathname: "/site-configuration", search: location.search }}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Site Configuration
          </Link>{" "}
          under <strong>Step 1 - Sites</strong>, then use <strong>Step 2 - BACnet discovery</strong> to add devices to the graph.
        </p>
      )}

      {/* Step-by-step guide - AI context via /model-context/docs + /mcp/manifest 
      <Card className="mb-8 border-primary/20 bg-primary/5">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <ListOrdered className="h-5 w-5" />
            How to build your data model
          </CardTitle>
          <p className="text-sm font-normal text-muted-foreground">
            Follow these steps in order. Use in-product context endpoints for AI workflow guidance.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li>
              <strong>Sites + BACnet discovery</strong> - On{" "}
              <Link
                to={{ pathname: "/site-configuration", search: location.search }}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Site Configuration
              </Link>
              : <strong>Step 1 - Sites</strong> (create a site if needed), then <strong>Step 2 - BACnet discovery</strong> (Who-Is,
              point discovery, <strong>Add to data model</strong>). Optional read/write tools on that page are not required for
              this flow.
            </li>
            <li>
              <strong>Export JSON and open your LLM</strong> - Download the export (Export section), then open your LLM chat. Pull prompt/context from{" "}
              <code className="rounded bg-muted px-1 text-xs">GET /model-context/docs</code> and tool mappings from{" "}
              <code className="rounded bg-muted px-1 text-xs">GET /mcp/manifest</code>. Upload your{" "}
              <strong>fault rule YAML files</strong> (from the Faults page) so the LLM knows which points your rules need.
            </li>
            <li>
              <strong>Chat with the LLM</strong> - Paste the exported JSON into the LLM. Confirm with the LLM that Brick types, feeds/fed-by, and rule_input are correct before asking for the final JSON.
            </li>
            <li>
              <strong>Apply back in Open-FDD</strong> - Copy the LLM’s JSON output and paste it into the “Paste from AI” section below (or choose a JSON file), then click <strong>Apply to data model</strong>.
            </li>
            <li>
              <strong>SPARQL test</strong> - Use the Data Model Testing page to run predefined summary queries (e.g. count AHUs, chillers) or your own SPARQL to confirm the data model returns the relationships and points you need for your algorithms and fault rules.
            </li>
          </ol>
        </CardContent>
      </Card>
*/}
      {/* Data model TTL - view, serialize, check */}
      <Card className="mt-6">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <FileText className="h-5 w-5" />
            Data model (TTL)
          </CardTitle>
          <p className="text-sm font-normal text-muted-foreground">
            View full Brick + BACnet graph as TTL, serialize to file, or run integrity check.
          </p>
          <div className="rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground leading-relaxed space-y-1.5">
            <p className="font-medium text-foreground/80">How this fits together</p>
            <ul className="list-disc pl-4 space-y-1">
              <li>
                <span className="text-foreground/90">Database (Postgres)</span> - source of truth for sites, equipment, and
                points (including BACnet addressing fields and <code className="rounded bg-muted px-1">external_id</code>, which
                maps samples in the time-series table). Deleting sites here removes that relational data.
              </li>
              <li>
                <span className="text-foreground/90">In-memory RDF graph</span> - Brick triples are rebuilt from the DB; BACnet
                discovery adds extra triples for SPARQL and tooling. Import/reset/sync all refresh this merge.
              </li>
              <li>
                <span className="text-foreground/90">TTL file on disk</span> - a persisted snapshot of that graph (default{" "}
                <code className="rounded bg-muted px-1">config/data_model.ttl</code>). The API also saves periodically in the
                background; &quot;Serialize to TTL&quot; forces a write without changing graph contents.
              </li>
            </ul>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleViewTtl}
              disabled={ttlLoading}
              className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-muted/50 px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
              title="Open full Brick + BACnet TTL in a new tab (raw text)"
            >
              <FileText className="h-4 w-4" />
              {ttlLoading ? "Loading…" : "View full data model (TTL)"}
            </button>
            <button
              type="button"
              onClick={() => serializeMutation.mutate()}
              disabled={serializeMutation.isPending}
              className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-muted/50 px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {serializeMutation.isPending ? "Serializing…" : "Serialize to TTL"}
            </button>
            <button
              type="button"
              onClick={() => checkMutation.mutate()}
              disabled={checkMutation.isPending}
              className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-muted/50 px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
            >
              <Search className="h-4 w-4" />
              {checkMutation.isPending ? "Checking…" : "Check integrity"}
            </button>
          </div>
          {ttlError && (
            <p className="text-sm text-destructive">{ttlError}</p>
          )}
          {serializeMutation.isSuccess && (
            <p className="text-sm text-muted-foreground">
              Serialized to {String((serializeMutation.data as { path?: string })?.path ?? "-")}
            </p>
          )}
          {checkResult != null && (
            <JsonPrettyPanel
              value={checkResult}
              maxHeightClass="max-h-56"
              defaultExpandDepth={2}
            />
          )}
        </CardContent>
      </Card>

        <div className="mt-6 space-y-6">

        {/* Export */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Database className="h-5 w-5" />
              Export
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Download JSON for the entire equip / point model for selected site
            </p>
            {exportLoading && <Skeleton className="h-48 w-full rounded-lg" />}
            {!exportLoading && exportJson && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => exportData && downloadJson(exportData, "data-model-export.json")}
                    className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-muted/50 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted self-start"
                    title="Download full export as JSON file for manual tagging in an external LLM"
                  >
                    <Download className="h-4 w-4" />
                    Download JSON
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Downloads both the <strong>equipment</strong> and <strong>points</strong> arrays for the selected site (or all
                  sites) - tag <code className="rounded bg-muted px-1">equipment_type</code> and{" "}
                  <code className="rounded bg-muted px-1">brick_type</code> / <code className="rounded bg-muted px-1">rule_input</code>,
                  then re-upload via Import below.
                </p>
              </div>
            )}
            {!exportLoading &&
              (!exportData || (exportData.points.length === 0 && exportData.equipment.length === 0)) && (
                <p className="text-sm text-muted-foreground">No points or equipment in the data model yet.</p>
              )}
          </CardContent>
        </Card>

        {/* AI tagging (Anthropic) - embedded export → tag → review → onboard */}
        <AiTaggingPanel available={capabilities?.ai_available} />

        {/* Import */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Upload className="h-5 w-5" />
              Import
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Paste JSON (array of points or <code className="rounded bg-muted px-1">{"{ points: [...] }"}</code>)
              or upload a JSON file, then click Import to update the data model. Same as PUT /data-model/import.
            </p>
            {importError && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <span className="font-medium">Import failed:</span> {importError}
              </div>
            )}
            <input
              ref={importFileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  try {
                    const text = String(reader.result ?? "");
                    JSON.parse(text);
                    setImportJson(text);
                  } catch {
                    setImportJson("");
                    alert("Invalid JSON in file. Check the file and try again.");
                  }
                  e.target.value = "";
                };
                reader.readAsText(file);
              }}
            />
            <textarea
              value={importJson}
              onChange={(e) => setImportJson(e.target.value)}
              placeholder='[{"point_id": "...", "brick_type": "Supply_Air_Temperature_Sensor", ...}] or { "points": [...] }'
              className="h-40 w-full rounded-lg border border-border/60 bg-card px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              spellCheck={false}
              data-testid="data-model-import-json"
            />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => importFileInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-muted/50 px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
                title="Load JSON from file into editor"
              >
                <FileUp className="h-4 w-4" />
                Upload JSON file
              </button>
              <button
                type="button"
                onClick={handleImport}
                disabled={importMutation.isPending || !importJson.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                data-testid="data-model-import-button"
              >
                <Upload className="h-4 w-4" />
                Import
              </button>
              {importResult != null && (
                <span className="text-sm text-muted-foreground">
                  {importResult.created != null && `Created: ${importResult.created}`}
                  {importResult.updated != null && ` Updated: ${importResult.updated}`}
                  {importResult.total != null && ` Total: ${importResult.total}`}
                  {importResult.equipment_updated != null && ` Equipment updated: ${importResult.equipment_updated}`}
                  {importResult.warnings?.length ? ` - ${importResult.warnings.join("; ")}` : ""}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Equipment */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Server className="h-5 w-5" />
              Equipment
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">
              Equipment in the data model. Filter by site using the site selector in the top bar.
            </p>
            {equipmentLoading && <Skeleton className="h-72 w-full rounded-lg" />}
            {!equipmentLoading && (
              <EquipmentTable
                equipment={equipment}
                points={points}
                faults={faults}
                siteMap={selectedSiteId ? undefined : siteMap}
              />
            )}
          </CardContent>
        </Card>

        {/* Danger zone - lower-risk reset first, nuclear delete-all last */}
        <Card className="border-amber-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-lg text-amber-700 dark:text-amber-400">
              <Trash2 className="h-5 w-5" />
              Danger zone
            </CardTitle>
            <p className="text-sm font-normal text-muted-foreground">
              <strong>Lower risk</strong> (below): reset the in-memory RDF graph and TTL from the current database - no Postgres
              deletes. <strong>Maximum risk</strong> (bottom): delete every site in the database (cascade), then the same graph
              reset. See also{" "}
              <a
                href="https://bbartling.github.io/open-fdd/frontend#data-model-danger-zone"
                className="font-medium text-primary underline-offset-2 hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                docs → React dashboard → Danger zone
              </a>
              .
            </p>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="rounded-lg border border-border/60 p-4">
              <p className="mb-1 text-sm font-medium text-amber-800 dark:text-amber-300/90">
                Lower risk - RDF / TTL reset only
              </p>
              <p className="mb-3 text-xs text-muted-foreground leading-relaxed">
                <span className="font-medium text-foreground/80">Danger level: moderate.</span> Calls{" "}
                <code className="rounded bg-muted px-1">POST /data-model/reset</code> only. Clears the in-memory graph, strips
                BACnet discovery triples and orphan blanks, rebuilds Brick triples from <strong>whatever is still in the
                database</strong>, then writes the TTL file. Your sites, points, and{" "}
                <code className="rounded bg-muted px-1">external_id</code> (time-series column mapping) stay in Postgres. Use this
                when discovery left stale BACnet RDF but you want to keep DB rows. For orphan warnings, use{" "}
                <strong>Check integrity</strong> above (this button does not run that check).
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="text"
                  value={resetConfirm}
                  onChange={(e) => setResetConfirm(e.target.value)}
                  placeholder="Type reset to confirm"
                  className="h-9 w-40 rounded-lg border border-border/60 bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={() => {
                    if (resetConfirm.trim().toLowerCase() !== "reset") {
                      alert('Type "reset" to confirm.');
                      return;
                    }
                    resetMutation.mutate();
                  }}
                  disabled={resetMutation.isPending || resetConfirm.trim().toLowerCase() !== "reset"}
                  className="inline-flex items-center gap-2 rounded-lg border border-amber-600/60 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-400"
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset graph to DB-only
                </button>
              </div>
              {resetMutation.isSuccess && (
                <p className="mt-2 text-sm text-muted-foreground">
                  {(resetMutation.data as { message?: string })?.message ?? "Graph reset."}
                </p>
              )}
            </div>
            <div className="rounded-lg border border-border/60 p-4">
              <p className="mb-1 text-sm font-medium text-amber-800 dark:text-amber-300/90">
                Low risk - delete empty equipment
              </p>
              <p className="mb-3 text-xs text-muted-foreground leading-relaxed">
                <span className="font-medium text-foreground/80">Danger level: low.</span> Calls{" "}
                <code className="rounded bg-muted px-1">POST /equipment/delete-empty</code> for{" "}
                <strong>{selectedSiteId ? siteMap.get(selectedSiteId)?.name ?? "the selected site" : "all sites"}</strong>.
                Removes equipment shells that have <strong>no points</strong> - left over after dissolving or re-tagging.
                Equipment that still has points is kept; <strong>points and time-series readings are not touched</strong>.
                {selectedSiteId
                  ? " Pick a different site (or clear the selection) to change the scope."
                  : " Select a site in the header to scope this to one site."}
              </p>
              <p className="mb-2 text-sm font-medium text-muted-foreground">
                {emptyEquipment.length === 0
                  ? "No empty equipment detected in the loaded data."
                  : `${emptyEquipment.length} empty equipment detected (estimate).`}
              </p>
              <button
                type="button"
                data-testid="delete-empty-equipment-button"
                onClick={() => {
                  const scope = selectedSiteId
                    ? siteMap.get(selectedSiteId)?.name ?? "the selected site"
                    : "all accessible sites";
                  if (
                    !window.confirm(
                      `Delete empty equipment in ${scope}? Equipment shells with no points are removed; ` +
                        "equipment that still has points is kept. Points and time-series are not affected.",
                    )
                  ) {
                    return;
                  }
                  deleteEmptyEquipmentMutation.mutate(selectedSiteId ?? undefined);
                }}
                disabled={deleteEmptyEquipmentMutation.isPending || emptyEquipment.length === 0}
                className="inline-flex items-center gap-2 rounded-lg border border-amber-600/60 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-400"
              >
                <Trash2 className="h-4 w-4" />
                Delete empty equipment
              </button>
              {deleteEmptyEquipmentMutation.isSuccess && (
                <p className="mt-2 text-sm text-muted-foreground">
                  {deleteEmptyEquipmentMutation.data.deleted === 0
                    ? "No empty equipment to delete."
                    : `Deleted ${deleteEmptyEquipmentMutation.data.deleted} empty equipment` +
                      (deleteEmptyEquipmentMutation.data.names.length
                        ? `: ${deleteEmptyEquipmentMutation.data.names.join(", ")}.`
                        : ".")}
                </p>
              )}
              {deleteEmptyEquipmentMutation.isError && (
                <p className="mt-2 text-sm text-destructive">
                  {deleteEmptyEquipmentMutation.error.message}
                </p>
              )}
            </div>
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
              <p className="mb-1 text-sm font-medium text-destructive">
                High risk - reset fault history for the selected site
              </p>
              <p className="mb-3 text-xs text-muted-foreground leading-relaxed">
                <span className="font-medium text-destructive/90">Danger level: high.</span> Calls{" "}
                <code className="rounded bg-background/80 px-1">POST /faults/reset</code> for{" "}
                <strong>only the selected site</strong>. Permanently deletes that site's fault history -{" "}
                <code className="rounded bg-background/80 px-1">fault_results</code>,{" "}
                <code className="rounded bg-background/80 px-1">fault_events</code>, and current{" "}
                <code className="rounded bg-background/80 px-1">fault_state</code>. Sites, equipment, points, and time-series
                readings are <strong>not</strong> touched. This never runs globally; pick a site in the header to enable it.
              </p>
              {!selectedSiteId ? (
                <p className="text-sm font-medium text-muted-foreground">
                  Select a site in the header to enable fault-history reset.
                </p>
              ) : (
                <>
                  <p className="mb-2 text-sm font-medium text-muted-foreground">
                    Target site: <strong className="text-foreground/90">{siteMap.get(selectedSiteId)?.name ?? selectedSiteId}</strong>
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={resetFaultsConfirm}
                      onChange={(e) => setResetFaultsConfirm(e.target.value)}
                      placeholder="Type reset to confirm"
                      className="h-9 w-40 rounded-lg border border-border/60 bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      data-testid="reset-faults-confirm-input"
                    />
                    <button
                      type="button"
                      data-testid="reset-faults-button"
                      onClick={() => {
                        if (resetFaultsConfirm.trim().toLowerCase() !== "reset") {
                          alert('Type "reset" to confirm.');
                          return;
                        }
                        resetFaultsMutation.mutate(selectedSiteId);
                      }}
                      disabled={resetFaultsMutation.isPending || resetFaultsConfirm.trim().toLowerCase() !== "reset"}
                      className="inline-flex items-center gap-2 rounded-lg border border-destructive/60 bg-destructive/10 px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-50"
                    >
                      <Trash2 className="h-4 w-4" />
                      Reset fault history for this site
                    </button>
                  </div>
                  {resetFaultsMutation.isSuccess && (
                    <p className="mt-2 text-sm text-muted-foreground">
                      Cleared {resetFaultsMutation.data.fault_results_deleted} fault result(s),{" "}
                      {resetFaultsMutation.data.fault_events_deleted} event(s), and{" "}
                      {resetFaultsMutation.data.fault_state_deleted} active state row(s) for{" "}
                      {resetFaultsMutation.data.site_name}.
                    </p>
                  )}
                  {resetFaultsMutation.isError && (
                    <p className="mt-2 text-sm text-destructive">{resetFaultsMutation.error.message}</p>
                  )}
                </>
              )}
            </div>
            {sites.length > 0 && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
                <p className="mb-1 text-sm font-medium text-destructive">Maximum risk - empty the database</p>
                <p className="mb-3 text-xs text-muted-foreground leading-relaxed">
                  <span className="font-medium text-destructive/90">Danger level: nuclear.</span> Calls{" "}
                  <code className="rounded bg-background/80 px-1">DELETE /sites/…</code> for every site (removes equipment,
                  points, and related data in the DB), then <code className="rounded bg-background/80 px-1">POST /data-model/reset</code>{" "}
                  so the RDF graph and TTL match the now-empty model. Time-series history for those points is gone with the site
                  cascade - not just the graph file.
                </p>
                <p className="mb-2 text-sm font-medium text-muted-foreground">Remove all sites from data model</p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={deleteAllConfirm}
                    onChange={(e) => setDeleteAllConfirm(e.target.value)}
                    placeholder={`Type ${sites.length} to confirm`}
                    className="h-9 w-40 rounded-lg border border-border/60 bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    data-testid="delete-all-confirm-input"
                  />
                  <button
                    type="button"
                    data-testid="delete-all-and-reset-button"
                    onClick={async () => {
                      if (deleteAllConfirm !== String(sites.length)) {
                        alert(`Type ${sites.length} in the box to confirm.`);
                        return;
                      }
                      try {
                        for (const s of sites) {
                          await deleteSite(s.id);
                        }
                        await dataModelReset();
                        setDeleteAllConfirm("");
                        queryClient.invalidateQueries({ queryKey: ["sites"] });
                        queryClient.invalidateQueries({ queryKey: ["data-model"] });
                        queryClient.invalidateQueries({ queryKey: ["equipment"] });
                        queryClient.invalidateQueries({ queryKey: ["points"] });
                        queryClient.invalidateQueries({ queryKey: ["faults"] });
                      } catch (err) {
                        alert(err instanceof Error ? err.message : "Remove all failed");
                      }
                    }}
                    disabled={deleteAllConfirm !== String(sites.length)}
                    className="inline-flex items-center gap-2 rounded-lg border border-destructive/60 bg-destructive/10 px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                    Remove all sites and reset graph
                  </button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-8">
        <BuildingQueriesCard />
      </div>
    </div>
  );
}
