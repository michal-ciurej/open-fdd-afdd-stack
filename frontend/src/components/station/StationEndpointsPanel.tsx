import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, PlugZap, Plus, Scan, RefreshCw, Save, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSiteContext } from "@/contexts/site-context";
import { timeAgo } from "@/lib/utils";
import type {
  NiagaraEndpoint,
  NiagaraEndpointCreateBody,
  NiagaraEndpointUpdateBody,
  NiagaraScanPoint,
} from "@/lib/crud-api";

const field =
  "h-9 rounded-lg border border-border/60 bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

/** Driver-specific API surface, injected by the Niagara / IQVision wrappers. */
export interface StationApi {
  listEndpoints: (siteId: string) => Promise<NiagaraEndpoint[]>;
  createEndpoint: (siteId: string, body: NiagaraEndpointCreateBody) => Promise<NiagaraEndpoint>;
  updateEndpoint: (endpointId: string, body: NiagaraEndpointUpdateBody) => Promise<NiagaraEndpoint>;
  deleteEndpoint: (endpointId: string) => Promise<void>;
  testEndpoint: (
    endpointId: string,
  ) => Promise<{ ok: boolean; status_code: number | null; error: string | null }>;
  startScan: (endpointId: string) => Promise<{ job_id: string; status: string }>;
  startSync: (endpointId: string, timeWindow: string) => Promise<{ job_id: string; status: string }>;
  listPoints: (endpointId: string) => Promise<{ count: number; points: NiagaraScanPoint[] }>;
}

export interface StationEndpointsPanelProps {
  driverKey: string;
  driverLabel: string;
  baseUrlPlaceholder: string;
  groupingHint: ReactNode;
  bqlWindows: readonly string[];
  defaultWindow: string;
  api: StationApi;
}

export function StationEndpointsPanel({
  driverKey,
  driverLabel,
  baseUrlPlaceholder,
  groupingHint,
  bqlWindows,
  defaultWindow,
  api,
}: StationEndpointsPanelProps) {
  const { selectedSiteId, selectedSite } = useSiteContext();
  const queryClient = useQueryClient();

  const endpointsKey = [driverKey, "endpoints", selectedSiteId];

  const endpointsQuery = useQuery({
    queryKey: endpointsKey,
    queryFn: () => api.listEndpoints(selectedSiteId!),
    enabled: !!selectedSiteId,
  });

  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sslVerify, setSslVerify] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [addStatus, setAddStatus] = useState<string | null>(null);

  const resetAddForm = () => {
    setName("");
    setBaseUrl("");
    setUsername("");
    setPassword("");
    setSslVerify(true);
    setEnabled(true);
  };

  const createMut = useMutation({
    mutationFn: () =>
      api.createEndpoint(selectedSiteId!, {
        name: name.trim(),
        base_url: baseUrl.trim(),
        username: username.trim(),
        password,
        ssl_verify: sslVerify,
        enabled,
      }),
    onSuccess: () => {
      setAddStatus(null);
      setShowAdd(false);
      resetAddForm();
      queryClient.invalidateQueries({ queryKey: endpointsKey });
    },
    onError: (e: Error) => setAddStatus(`Add failed: ${e.message}`),
  });

  if (!selectedSiteId) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Select a site from the top bar to configure its {driverLabel} endpoints.
        </CardContent>
      </Card>
    );
  }

  const endpoints = endpointsQuery.data ?? [];
  const addDisabled =
    createMut.isPending ||
    name.trim().length === 0 ||
    baseUrl.trim().length === 0 ||
    username.trim().length === 0 ||
    password.trim().length === 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2">
            <PlugZap className="h-5 w-5" />
            {driverLabel} endpoints
            {selectedSite && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                — {selectedSite.name}
              </span>
            )}
          </CardTitle>
          <p className="text-sm font-normal text-muted-foreground">
            A site can have several {driverLabel} endpoints (e.g. one per controller). Each is
            scanned and synced independently. {groupingHint}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {!showAdd && (
            <button
              type="button"
              onClick={() => {
                setAddStatus(null);
                setShowAdd(true);
              }}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" />
              Add endpoint
            </button>
          )}

          {showAdd && (
            <div className="space-y-4 rounded-lg border border-border/60 p-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
                  <input
                    className={`${field} w-full`}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. AHU controller"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Base URL</label>
                  <input
                    className={`${field} w-full`}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={baseUrlPlaceholder}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Username</label>
                  <input
                    className={`${field} w-full`}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Password</label>
                  <input
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
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => createMut.mutate()}
                  disabled={addDisabled}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {createMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAdd(false);
                    setAddStatus(null);
                    resetAddForm();
                  }}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-border/60 px-4 text-sm font-medium transition-colors hover:bg-muted"
                >
                  Cancel
                </button>
              </div>
              {addStatus && <p className="text-sm text-destructive">{addStatus}</p>}
            </div>
          )}

          {endpointsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : endpoints.length === 0 && !showAdd ? (
            <p className="text-sm text-muted-foreground">
              No {driverLabel} endpoints yet. Click <strong>Add endpoint</strong> to configure one.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {endpoints.map((ep) => (
        <StationEndpointCard
          key={ep.id}
          endpoint={ep}
          driverKey={driverKey}
          driverLabel={driverLabel}
          baseUrlPlaceholder={baseUrlPlaceholder}
          bqlWindows={bqlWindows}
          defaultWindow={defaultWindow}
          api={api}
          onChanged={() => queryClient.invalidateQueries({ queryKey: endpointsKey })}
        />
      ))}
    </div>
  );
}

interface StationEndpointCardProps {
  endpoint: NiagaraEndpoint;
  driverKey: string;
  driverLabel: string;
  baseUrlPlaceholder: string;
  bqlWindows: readonly string[];
  defaultWindow: string;
  api: StationApi;
  onChanged: () => void;
}

function StationEndpointCard({
  endpoint,
  driverKey,
  driverLabel,
  baseUrlPlaceholder,
  bqlWindows,
  defaultWindow,
  api,
  onChanged,
}: StationEndpointCardProps) {
  const queryClient = useQueryClient();

  const [name, setName] = useState(endpoint.name);
  const [baseUrl, setBaseUrl] = useState(endpoint.base_url);
  const [username, setUsername] = useState(endpoint.username);
  const [password, setPassword] = useState("");
  const [sslVerify, setSslVerify] = useState(endpoint.ssl_verify);
  const [enabled, setEnabled] = useState(endpoint.enabled);
  const [timeWindow, setTimeWindow] = useState<string>(defaultWindow);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const pointsKey = [driverKey, "points", endpoint.id];
  const pointsQuery = useQuery({
    queryKey: pointsKey,
    queryFn: () => api.listPoints(endpoint.id),
  });

  const saveMut = useMutation({
    mutationFn: () =>
      api.updateEndpoint(endpoint.id, {
        name: name.trim(),
        base_url: baseUrl.trim(),
        username: username.trim(),
        password: password || undefined,
        ssl_verify: sslVerify,
        enabled,
      }),
    onSuccess: () => {
      setStatusMsg("Endpoint saved.");
      setPassword("");
      onChanged();
    },
    onError: (e: Error) => setStatusMsg(`Save failed: ${e.message}`),
  });

  const deleteMut = useMutation({
    mutationFn: () => api.deleteEndpoint(endpoint.id),
    onSuccess: () => {
      setStatusMsg("Endpoint removed.");
      onChanged();
    },
    onError: (e: Error) => setStatusMsg(`Delete failed: ${e.message}`),
  });

  const testMut = useMutation({
    mutationFn: () => api.testEndpoint(endpoint.id),
    onSuccess: (r) => setStatusMsg(`Reachable (HTTP ${r.status_code}).`),
    onError: (e: Error) => setStatusMsg(`Unreachable: ${e.message}`),
  });

  const scanMut = useMutation({
    mutationFn: () => api.startScan(endpoint.id),
    onSuccess: (r) =>
      setStatusMsg(`Scan queued (job ${r.job_id}). Points refresh when it finishes.`),
    onError: (e: Error) => setStatusMsg(`Scan failed: ${e.message}`),
  });

  const syncMut = useMutation({
    mutationFn: () => api.startSync(endpoint.id, timeWindow),
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

  const saveDisabled =
    saveMut.isPending || baseUrl.trim().length === 0 || username.trim().length === 0 || name.trim().length === 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          {name || endpoint.name}
          {!enabled && (
            <span className="rounded bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
              disabled
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
            <input className={`${field} w-full`} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Base URL</label>
            <input
              className={`${field} w-full`}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={baseUrlPlaceholder}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Username</label>
            <input
              className={`${field} w-full`}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Password <span className="text-muted-foreground/60">(leave blank to keep current)</span>
            </label>
            <input
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
            disabled={testMut.isPending}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border/60 px-4 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
          >
            {testMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
            Test connection
          </button>
          <button
            type="button"
            onClick={() => scanMut.mutate()}
            disabled={scanMut.isPending}
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
              {bqlWindows.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => syncMut.mutate()}
              disabled={syncMut.isPending}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border/60 px-4 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
            >
              {syncMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Sync history
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Remove the ${driverLabel} endpoint "${endpoint.name}"? Its discovered points will be deleted.`)) {
                deleteMut.mutate();
              }
            }}
            disabled={deleteMut.isPending}
            className="ml-auto inline-flex h-9 items-center gap-2 rounded-lg border border-destructive/40 px-4 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
          >
            {deleteMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Delete
          </button>
        </div>

        {statusMsg && <p className="text-sm text-muted-foreground">{statusMsg}</p>}

        <div className="flex flex-wrap items-center gap-6 text-xs text-muted-foreground">
          <span>Last scan: {endpoint.last_scan_ts ? timeAgo(endpoint.last_scan_ts) : "never"}</span>
          <span>Last sync: {endpoint.last_sync_ts ? timeAgo(endpoint.last_sync_ts) : "never"}</span>
          <button
            type="button"
            onClick={() => queryClient.invalidateQueries({ queryKey: pointsKey })}
            className="underline hover:text-foreground"
          >
            Refresh points
          </button>
        </div>

        <div>
          <h4 className="mb-1 text-sm font-medium">
            Discovered points{" "}
            {pointsQuery.data ? (
              <span className="text-muted-foreground">({pointsQuery.data.count})</span>
            ) : null}
          </h4>
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
                  <h5 className="mb-1 text-sm font-medium">
                    {equipName} <span className="text-muted-foreground">({rows.length})</span>
                  </h5>
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
        </div>
      </CardContent>
    </Card>
  );
}
