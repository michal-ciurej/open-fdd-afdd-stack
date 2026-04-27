import { apiFetch } from "@/lib/api";
import type {
  DataModelExportRow,
  DataModelImportBody,
  DataModelImportResponse,
  EnergyCalculation,
  EnergyCalculationCreateBody,
  EnergyCalculationPatchBody,
  EnergyCalculationsExportPayload,
  EnergyCalculationsImportBody,
  EnergyCalculationsImportResponse,
  EnergyCalcTypePublic,
  EnergyPreviewResult,
  PlatformConfig,
  Point,
  PointPatchBody,
  Site,
} from "@/types/api";

export interface SiteCreate {
  name: string;
  description?: string | null;
}

export interface DataModelCheckResponse {
  triple_count: number;
  blank_node_count: number;
  orphan_blank_nodes: number;
  sites: number;
  bacnet_devices: number;
  warnings: string[];
}

export interface WhoIsRangeBody {
  request: {
    start_instance: number;
    end_instance: number;
  };
  url?: string;
}

export interface PointDiscoveryBody {
  instance: {
    device_instance: number;
  };
  url?: string;
}

export interface PointDiscoveryToGraphBody extends PointDiscoveryBody {
  update_graph?: boolean;
  write_file?: boolean;
}

export interface WhoIsResponse {
  ok?: boolean;
  body?: unknown;
  error?: string;
}

export interface PointDiscoveryResponse {
  ok?: boolean;
  body?: unknown;
  error?: string;
}

export function getConfig() {
  return apiFetch<PlatformConfig>("/config");
}

export function putConfig(body: PlatformConfig) {
  return apiFetch<PlatformConfig>("/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function createSite(body: SiteCreate) {
  return apiFetch<Site>("/sites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteSite(siteId: string) {
  return apiFetch<{ status: string }>(`/sites/${siteId}`, {
    method: "DELETE",
  });
}

export function deleteEquipment(equipmentId: string) {
  return apiFetch<{ status: string }>(`/equipment/${equipmentId}`, {
    method: "DELETE",
  });
}

export function deletePoint(pointId: string) {
  return apiFetch<{ status: string }>(`/points/${pointId}`, {
    method: "DELETE",
  });
}

export type PointCreateBody = {
  site_id: string;
  external_id: string;
  brick_type?: string | null;
  fdd_input?: string | null;
  unit?: string | null;
  description?: string | null;
  equipment_id?: string | null;
  bacnet_device_id?: string | null;
  object_identifier?: string | null;
  object_name?: string | null;
  polling?: boolean | null;
  modbus_config?: Record<string, unknown> | null;
};

export function createPoint(body: PointCreateBody): Promise<Point> {
  return apiFetch<Point>("/points", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** PATCH a point — any subset of PointPatchBody (matches backend PointUpdate). */
export function updatePoint(pointId: string, body: PointPatchBody): Promise<Point> {
  return apiFetch<Point>(`/points/${pointId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function dataModelExport() {
  return apiFetch<DataModelExportRow[]>("/data-model/export");
}

export function dataModelImport(body: DataModelImportBody) {
  return apiFetch<DataModelImportResponse>("/data-model/import", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function dataModelSerialize() {
  return apiFetch<{ status: string; path?: string; path_resolved?: string; error?: string }>(
    "/data-model/serialize",
    { method: "POST" },
  );
}

export function dataModelReset() {
  return apiFetch<{ status: string; path?: string; message?: string; error?: string }>(
    "/data-model/reset",
    { method: "POST" },
  );
}

export function dataModelCheck() {
  return apiFetch<DataModelCheckResponse>("/data-model/check");
}

export function listEnergyCalcTypes() {
  return apiFetch<{ calc_types: EnergyCalcTypePublic[] }>("/energy-calculations/calc-types");
}

export function listEnergyCalculations(siteId: string, equipmentId?: string) {
  const p = new URLSearchParams();
  p.set("site_id", siteId);
  if (equipmentId) p.set("equipment_id", equipmentId);
  return apiFetch<EnergyCalculation[]>(`/energy-calculations?${p.toString()}`);
}

export function previewEnergyCalculation(
  calc_type: string,
  parameters: Record<string, unknown>,
) {
  return apiFetch<EnergyPreviewResult>("/energy-calculations/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ calc_type, parameters }),
  });
}

export function createEnergyCalculation(body: EnergyCalculationCreateBody) {
  return apiFetch<EnergyCalculation>("/energy-calculations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteEnergyCalculation(id: string) {
  return apiFetch<{ status: string }>(`/energy-calculations/${id}`, {
    method: "DELETE",
  });
}

export function exportEnergyCalculations(siteId: string) {
  const q = new URLSearchParams();
  q.set("site_id", siteId);
  return apiFetch<EnergyCalculationsExportPayload>(`/energy-calculations/export?${q.toString()}`);
}

export function importEnergyCalculations(body: EnergyCalculationsImportBody) {
  return apiFetch<EnergyCalculationsImportResponse>("/energy-calculations/import", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function seedDefaultPenaltyCatalog(siteId: string, replace = false) {
  const q = new URLSearchParams();
  q.set("site_id", siteId);
  if (replace) q.set("replace", "true");
  return apiFetch<{
    site_id: string;
    created: number;
    rows_in_catalog: number;
    deleted_before_insert: number;
    replace: boolean;
  }>(`/energy-calculations/seed-default-penalty-catalog?${q.toString()}`, { method: "POST" });
}

export function updateEnergyCalculation(id: string, patch: EnergyCalculationPatchBody) {
  return apiFetch<EnergyCalculation>(`/energy-calculations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function bacnetWhoisRange(body: WhoIsRangeBody) {
  return apiFetch<WhoIsResponse>("/bacnet/whois_range", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function bacnetPointDiscovery(body: PointDiscoveryBody) {
  return apiFetch<PointDiscoveryResponse>("/bacnet/point_discovery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function bacnetPointDiscoveryToGraph(body: PointDiscoveryToGraphBody) {
  return apiFetch<PointDiscoveryResponse>("/bacnet/point_discovery_to_graph", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** GET /bacnet/gateways */
export type BacnetGatewayRow = { id: string; url: string; description?: string };

export function bacnetGateways() {
  return apiFetch<BacnetGatewayRow[]>("/bacnet/gateways");
}

export type BacnetProxyResult = Record<string, unknown>;

function _bacnetGw(gateway: string) {
  return `?gateway=${encodeURIComponent(gateway)}`;
}

export type ReadPropertyProxyBody = {
  url?: string;
  request: {
    device_instance: number;
    object_identifier: string;
    property_identifier?: string;
  };
};

export function bacnetReadProperty(body: ReadPropertyProxyBody, gateway: string) {
  return apiFetch<BacnetProxyResult>(`/bacnet/read_property${_bacnetGw(gateway)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export type ReadMultipleProxyBody = {
  url?: string;
  request: {
    device_instance: number;
    requests: { object_identifier: string; property_identifier: string }[];
  };
};

export function bacnetReadMultiple(body: ReadMultipleProxyBody, gateway: string) {
  return apiFetch<BacnetProxyResult>(`/bacnet/read_multiple${_bacnetGw(gateway)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export type WritePropertyProxyBody = {
  url?: string;
  request: {
    device_instance: number;
    object_identifier: string;
    property_identifier?: string;
    value: number | string | null;
    priority: number;
  };
};

export function bacnetWriteProperty(body: WritePropertyProxyBody, gateway: string) {
  return apiFetch<BacnetProxyResult>(`/bacnet/write_property${_bacnetGw(gateway)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function bacnetSupervisoryLogicChecks(
  body: PointDiscoveryBody,
  gateway: string,
) {
  return apiFetch<BacnetProxyResult>(`/bacnet/supervisory_logic_checks${_bacnetGw(gateway)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function bacnetReadPointPriorityArray(
  body: {
    url?: string;
    request: { device_instance: number; object_identifier: string };
  },
  gateway: string,
) {
  return apiFetch<BacnetProxyResult>(`/bacnet/read_point_priority_array${_bacnetGw(gateway)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Proxy to gateway POST /modbus/read_registers (utility meters, eGauge, etc.). */
export function bacnetModbusReadRegisters(
  body: Record<string, unknown>,
  gateway: string,
) {
  return apiFetch<BacnetProxyResult>(`/bacnet/modbus_read_registers${_bacnetGw(gateway)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Rules API (FDD rule YAML: list, upload, delete, sync definitions)
export function uploadRule(filename: string, content: string) {
  return apiFetch<{ ok: boolean; path?: string; filename?: string }>("/rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, content }),
  });
}

export function deleteRule(filename: string) {
  return apiFetch<{ ok?: boolean; filename?: string }>(`/rules/${encodeURIComponent(filename)}`, {
    method: "DELETE",
  });
}

export function syncRuleDefinitions() {
  return apiFetch<{ ok: boolean }>("/rules/sync-definitions", {
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// Niagara per-site endpoints + scan + sync
// ---------------------------------------------------------------------------

export interface NiagaraEndpoint {
  site_id: string;
  base_url: string;
  username: string;
  ssl_verify: boolean;
  enabled: boolean;
  last_scan_ts?: string | null;
  last_sync_ts?: string | null;
}

export interface NiagaraEndpointUpsertBody {
  base_url: string;
  username: string;
  password: string;
  ssl_verify: boolean;
  enabled: boolean;
}

export interface NiagaraScanPoint {
  id: string;
  external_id: string;
  equipment_id: string | null;
  equipment_name: string | null;
  niagara_nav_ord: string | null;
  niagara_tags: Record<string, unknown> | null;
  niagara_history_path: string | null;
}

export function listNiagaraEndpoints() {
  return apiFetch<NiagaraEndpoint[]>("/niagara/endpoints");
}

export function getNiagaraEndpoint(siteId: string) {
  return apiFetch<NiagaraEndpoint>(`/niagara/endpoints/${encodeURIComponent(siteId)}`);
}

export function putNiagaraEndpoint(siteId: string, body: NiagaraEndpointUpsertBody) {
  return apiFetch<NiagaraEndpoint>(`/niagara/endpoints/${encodeURIComponent(siteId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteNiagaraEndpoint(siteId: string) {
  return apiFetch<void>(`/niagara/endpoints/${encodeURIComponent(siteId)}`, {
    method: "DELETE",
  });
}

export function testNiagaraEndpoint(siteId: string) {
  return apiFetch<{ ok: boolean; status_code: number | null; error: string | null }>(
    `/niagara/endpoints/${encodeURIComponent(siteId)}/test`,
    { method: "POST" },
  );
}

export function startNiagaraScan(siteId: string) {
  return apiFetch<{ job_id: string; status: string }>(
    `/niagara/endpoints/${encodeURIComponent(siteId)}/scan`,
    { method: "POST" },
  );
}

export function startNiagaraSync(siteId: string, timeWindow = "lastweek") {
  return apiFetch<{ job_id: string; status: string }>(
    `/niagara/endpoints/${encodeURIComponent(siteId)}/sync`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ time_window: timeWindow }),
    },
  );
}

export function listNiagaraPoints(siteId: string) {
  return apiFetch<{ count: number; points: NiagaraScanPoint[] }>(
    `/niagara/endpoints/${encodeURIComponent(siteId)}/points`,
  );
}

// ---------------------------------------------------------------------------
// IQVision per-site endpoints + scan + sync
// Mirrors the Niagara API shape. Points are grouped by the BQL Device column
// instead of the nav ORD folder twice removed. Point rows share the
// niagara_* metadata columns on the backend.
// ---------------------------------------------------------------------------

export type IQVisionEndpoint = NiagaraEndpoint;
export type IQVisionEndpointUpsertBody = NiagaraEndpointUpsertBody;
export type IQVisionScanPoint = NiagaraScanPoint;

export function listIQVisionEndpoints() {
  return apiFetch<IQVisionEndpoint[]>("/iqvision/endpoints");
}

export function getIQVisionEndpoint(siteId: string) {
  return apiFetch<IQVisionEndpoint>(`/iqvision/endpoints/${encodeURIComponent(siteId)}`);
}

export function putIQVisionEndpoint(siteId: string, body: IQVisionEndpointUpsertBody) {
  return apiFetch<IQVisionEndpoint>(`/iqvision/endpoints/${encodeURIComponent(siteId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteIQVisionEndpoint(siteId: string) {
  return apiFetch<void>(`/iqvision/endpoints/${encodeURIComponent(siteId)}`, {
    method: "DELETE",
  });
}

export function testIQVisionEndpoint(siteId: string) {
  return apiFetch<{ ok: boolean; status_code: number | null; error: string | null }>(
    `/iqvision/endpoints/${encodeURIComponent(siteId)}/test`,
    { method: "POST" },
  );
}

export function startIQVisionScan(siteId: string) {
  return apiFetch<{ job_id: string; status: string }>(
    `/iqvision/endpoints/${encodeURIComponent(siteId)}/scan`,
    { method: "POST" },
  );
}

export function startIQVisionSync(siteId: string, timeWindow = "lastweek") {
  return apiFetch<{ job_id: string; status: string }>(
    `/iqvision/endpoints/${encodeURIComponent(siteId)}/sync`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ time_window: timeWindow }),
    },
  );
}

export function listIQVisionPoints(siteId: string) {
  return apiFetch<{ count: number; points: IQVisionScanPoint[] }>(
    `/iqvision/endpoints/${encodeURIComponent(siteId)}/points`,
  );
}
