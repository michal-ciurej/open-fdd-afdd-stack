import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, PlugZap, Scan, RefreshCw, Save, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSiteContext } from "@/contexts/site-context";
import {
  deleteNiagaraEndpoint,
  getNiagaraEndpoint,
  listNiagaraPoints,
  putNiagaraEndpoint,
  startNiagaraScan,
  startNiagaraSync,
  testNiagaraEndpoint,
  type NiagaraScanPoint,
} from "@/lib/crud-api";
import { timeAgo } from "@/lib/utils";

const field =
  "h-9 rounded-lg border border-border/60 bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

const BQL_WINDOWS = [
  "today",
  "yesterday",
  "lastWeek",
  "thisWeek",
  "weektodate",
  "lastMonth",
  "thisMonth",
] as const;

export function NiagaraConfigPanel() {
  const { selectedSiteId, selectedSite } = useSiteContext();
  const queryClient = useQueryClient();

  const endpointQuery = useQuery({
    queryKey: ["niagara", "endpoint", selectedSiteId],
    queryFn: () => getNiagaraEndpoint(selectedSiteId!),
    enabled: !!selectedSiteId,
    retry: false,
  });

  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sslVerify, setSslVerify] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [timeWindow, setTimeWindow] = useState<string>("lastweek");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    const ep = endpointQuery.data;
    if (ep) {
      setBaseUrl(ep.base_url);
      setUsername(ep.username);
      setPassword("");
      setSslVerify(ep.ssl_verify);
      setEnabled(ep.enabled);
    } else {
      setBaseUrl("");
      setUsername("");
      setPassword("");
      setSslVerify(true);
      setEnabled(true);
    }
  }, [endpointQuery.data, selectedSiteId]);

  const pointsQuery = useQuery({
    queryKey: ["niagara", "points", selectedSiteId],
    queryFn: () => listNiagaraPoints(selectedSiteId!),
    enabled: !!selectedSiteId && !!endpointQuery.data,
  });

  const saveMut = useMutation({
    mutationFn: () =>
      putNiagaraEndpoint(selectedSiteId!, {
        base_url: baseUrl.trim(),
        username: username.trim(),
        password,
        ssl_verify: sslVerify,
        enabled,
      }),
    onSuccess: () => {
      setStatusMsg("Endpoint saved.");
      setPassword("");
      queryClient.invalidateQueries({ queryKey: ["niagara", "endpoint", selectedSiteId] });
    },
    onError: (e: Error) => setStatusMsg(`Save failed: ${e.message}`),
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteNiagaraEndpoint(selectedSiteId!),
    onSuccess: () => {
      setStatusMsg("Endpoint removed.");
      queryClient.invalidateQueries({ queryKey: ["niagara", "endpoint", selectedSiteId] });
      queryClient.invalidateQueries({ queryKey: ["niagara", "points", selectedSiteId] });
    },
    onError: (e: Error) => setStatusMsg(`Delete failed: ${e.message}`),
  });

  const testMut = useMutation({
    mutationFn: () => testNiagaraEndpoint(selectedSiteId!),
    onSuccess: (r) => setStatusMsg(`Reachable (HTTP ${r.status_code}).`),
    onError: (e: Error) => setStatusMsg(`Unreachable: ${e.message}`),
  });

  const scanMut = useMutation({
    mutationFn: () => startNiagaraScan(selectedSiteId!),
    onSuccess: (r) => setStatusMsg(`Scan queued (job ${r.job_id}). Points will refresh when it finishes.`),
    onError: (e: Error) => setStatusMsg(`Scan failed: ${e.message}`),
  });

  const syncMut = useMutation({
    mutationFn: () => startNiagaraSync(selectedSiteId!, timeWindow),
    onSuccess: (r) => setStatusMsg(`Sync queued (job ${r.job_id}, window ${timeWindow}).`),
    onError: (e: Error) => setStatusMsg(`Sync failed: ${e.message}`),
  });

  const pointsByEquip = useMemo(() => {
    const groups = new Map<string, NiagaraScanPoint[]>();
    const rows = pointsQuery.data?.points ?? [];
    for (const p of rows) {
      const key = p.equipment_name ?? "(unassigned)";
      const arr = groups.get(key) ?? [];
      arr.push(p);
      groups.set(key, arr);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [pointsQuery.data]);

  if (!selectedSiteId) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Select a site from the top bar to configure its Niagara endpoint.
        </CardContent>
      </Card>
    );
  }

  const hasEndpoint = !!endpointQuery.data;
  const passwordMissing = !hasEndpoint && password.trim().length === 0;
  const saveDisabled =
    saveMut.isPending ||
    baseUrl.trim().length === 0 ||
    username.trim().length === 0 ||
    passwordMissing;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2">
            <PlugZap className="h-5 w-5" />
            Niagara endpoint
            {selectedSite && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                — {selectedSite.name}
              </span>
            )}
          </CardTitle>
          <p className="text-sm font-normal text-muted-foreground">
            Per-site Niagara station credentials. Scans discover control points via BQL; syncs
            pull history for points that carry an <code className="rounded bg-muted px-1 text-xs">n:history</code> tag.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label htmlFor="niagara-base-url" className="mb-1 block text-xs font-medium text-muted-foreground">
                Base URL
              </label>
              <input
                id="niagara-base-url"
                className={`${field} w-full`}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://station.local"
              />
            </div>
            <div>
              <label htmlFor="niagara-username" className="mb-1 block text-xs font-medium text-muted-foreground">
                Username
              </label>
              <input
                id="niagara-username"
                className={`${field} w-full`}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="niagara-password" className="mb-1 block text-xs font-medium text-muted-foreground">
                Password {hasEndpoint && <span className="text-muted-foreground/60">(leave blank to keep current)</span>}
              </label>
              <input
                id="niagara-password"
                type="password"
                className={`${field} w-full`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="flex items-center gap-6 self-end pb-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={sslVerify}
                  onChange={(e) => setSslVerify(e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                Verify SSL
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                Enabled
              </label>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            <button
              type="button"
              onClick={() => saveMut.mutate()}
              disabled={saveDisabled}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save
            </button>
            <button
              type="button"
              onClick={() => testMut.mutate()}
              disabled={!hasEndpoint || testMut.isPending}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border/60 px-4 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
            >
              {testMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
              Test connection
            </button>
            <button
              type="button"
              onClick={() => scanMut.mutate()}
              disabled={!hasEndpoint || scanMut.isPending}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border/60 px-4 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
            >
              {scanMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scan className="h-4 w-4" />}
              Scan station
            </button>
            <div className="flex items-center gap-2">
              <select
                value={timeWindow}
                onChange={(e) => setTimeWindow(e.target.value)}
                className={`${field} w-36`}
                aria-label="bqltime window"
              >
                {BQL_WINDOWS.map((w) => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => syncMut.mutate()}
                disabled={!hasEndpoint || syncMut.isPending}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-border/60 px-4 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
              >
                {syncMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Sync history
              </button>
            </div>
            {hasEndpoint && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm("Remove the Niagara endpoint for this site?")) {
                    deleteMut.mutate();
                  }
                }}
                disabled={deleteMut.isPending}
                className="ml-auto inline-flex h-9 items-center gap-2 rounded-lg border border-destructive/40 px-4 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
              >
                {deleteMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Delete
              </button>
            )}
          </div>

          {statusMsg && (
            <p className="text-sm text-muted-foreground">{statusMsg}</p>
          )}

          {endpointQuery.data && (
            <div className="flex gap-6 text-xs text-muted-foreground">
              <span>
                Last scan:{" "}
                {endpointQuery.data.last_scan_ts
                  ? timeAgo(endpointQuery.data.last_scan_ts)
                  : "never"}
              </span>
              <span>
                Last sync:{" "}
                {endpointQuery.data.last_sync_ts
                  ? timeAgo(endpointQuery.data.last_sync_ts)
                  : "never"}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {hasEndpoint && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Discovered points</CardTitle>
            <p className="text-sm font-normal text-muted-foreground">
              Grouped by equipment (derived from the nav ORD folder twice removed). A tag value
              starting with <code className="rounded bg-muted px-1 text-xs">n:history=</code> links
              the point to its history stream for sync.
            </p>
          </CardHeader>
          <CardContent>
            {pointsQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : pointsByEquip.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No points yet. Run <strong>Scan station</strong> to discover control points.
              </p>
            ) : (
              <div className="space-y-4">
                {pointsByEquip.map(([equipName, rows]) => (
                  <div key={equipName}>
                    <h3 className="mb-1 text-sm font-medium">{equipName} <span className="text-muted-foreground">({rows.length})</span></h3>
                    <div className="overflow-x-auto rounded-lg border border-border/60">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/40 text-left">
                          <tr>
                            <th className="px-2 py-1 font-medium">Point</th>
                            <th className="px-2 py-1 font-medium">History path</th>
                            <th className="px-2 py-1 font-medium">Tags</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((p) => (
                            <tr key={p.id} className="border-t border-border/40">
                              <td className="px-2 py-1 font-mono">{p.external_id}</td>
                              <td className="px-2 py-1 font-mono">{p.niagara_history_path ?? "—"}</td>
                              <td className="px-2 py-1 font-mono text-muted-foreground">
                                {p.niagara_tags
                                  ? Object.entries(p.niagara_tags)
                                      .map(([k, v]) => (v === true ? k : `${k}=${v}`))
                                      .join(", ")
                                  : ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
