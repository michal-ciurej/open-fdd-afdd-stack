"use client";

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Network, Plus, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import { bacnetModbusReadRegisters, createPoint, type BacnetProxyResult } from "@/lib/crud-api";
import type { Point } from "@/types/api";
import { useSites } from "@/hooks/use-sites";
import { BacnetProxyResultView } from "@/components/bacnet/BacnetProxyResultView";

const fieldClass =
  "h-9 rounded-lg border border-border/60 bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const monoClass = `${fieldClass} font-mono text-xs`;

/** Matches diy-bacnet-server `DecodeLiteral` (bacpypes_server/modbus_routes.py). */
export const MODBUS_DECODE_VALUES = [
  "",
  "raw",
  "uint16",
  "int16",
  "uint32",
  "int32",
  "float32",
] as const;

export type ModbusDecodeValue = (typeof MODBUS_DECODE_VALUES)[number];

const MODBUS_DECODE_LABELS: Record<ModbusDecodeValue, string> = {
  "": "Default (server decides)",
  raw: "Raw - 16-bit words only",
  uint16: "uint16 - 1 register",
  int16: "int16 - 1 register",
  uint32: "uint32 - 2 registers",
  int32: "int32 - 2 registers",
  float32: "float32 - 2 registers",
};

function decodeNeedsTwoRegisters(v: string): boolean {
  return v === "float32" || v === "uint32" || v === "int32";
}

/** Rule-safe id from a human name (also used as fdd_input). */
function toRuleExternalId(name: string): string {
  const t = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return t;
}

export type ModbusRegRow = {
  address: string;
  count: string;
  function: "holding" | "input";
  decode: ModbusDecodeValue;
  scale: string;
  offset: string;
  /** Human-readable name; drives external_id, description, fdd_input, and Modbus label. */
  pointName: string;
  unit: string;
};

const defaultRow = (): ModbusRegRow => ({
  address: "0",
  count: "1",
  function: "holding",
  decode: "uint16",
  scale: "",
  offset: "",
  pointName: "",
  unit: "",
});

type ModbusClientPanelProps = {
  gateway: string;
};

export function ModbusClientPanel({ gateway }: ModbusClientPanelProps) {
  const queryClient = useQueryClient();
  const { data: sites = [] } = useSites();
  const [siteId, setSiteId] = useState("");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("502");
  const [unitId, setUnitId] = useState("1");
  const [timeoutSec, setTimeoutSec] = useState("5");
  const [rows, setRows] = useState<ModbusRegRow[]>([defaultRow()]);
  const [testRes, setTestRes] = useState<BacnetProxyResult | null>(null);
  const [testResGateway, setTestResGateway] = useState<string | null>(null);
  const testGwRef = useRef("");

  const testMut = useMutation({
    mutationFn: () => {
      testGwRef.current = gateway;
      const registers = rows
        .map((r) => {
          const addr = parseInt(r.address.trim(), 10);
          const count = parseInt((r.count || "1").trim(), 10) || 1;
          if (!Number.isFinite(addr) || addr < 0) return null;
          const reg: Record<string, unknown> = {
            address: addr,
            count,
            function: r.function,
          };
          if (r.decode) reg.decode = r.decode;
          const sc = r.scale.trim();
          if (sc !== "" && !Number.isNaN(Number(sc))) reg.scale = Number(sc);
          const off = r.offset.trim();
          if (off !== "" && !Number.isNaN(Number(off))) reg.offset = Number(off);
          const nm = r.pointName.trim();
          if (nm) reg.label = nm;
          return reg;
        })
        .filter(Boolean) as Record<string, unknown>[];
      if (!host.trim()) {
        return Promise.reject(new Error("Enter Modbus host."));
      }
      if (registers.length === 0) {
        return Promise.reject(new Error("Add at least one valid register row (address)."));
      }
      const body: Record<string, unknown> = {
        host: host.trim(),
        port: parseInt(port, 10) || 502,
        unit_id: parseInt(unitId, 10) || 1,
        timeout: Math.min(60, Math.max(1, parseFloat(timeoutSec) || 5)),
        registers,
      };
      return bacnetModbusReadRegisters(body, gateway);
    },
    onMutate: () => {
      setTestRes(null);
      setTestResGateway(null);
    },
    onSuccess: (d) => {
      setTestRes(d as BacnetProxyResult);
      setTestResGateway(testGwRef.current);
    },
    onError: (e: Error) => {
      setTestRes({ ok: false, error: e instanceof Error ? e.message : String(e) });
      setTestResGateway(testGwRef.current);
    },
  });

  const addMut = useMutation({
    mutationFn: async () => {
      const sid = siteId.trim() || sites[0]?.id;
      if (!sid) {
        throw new Error("Select a site (create one under the BACnet tab, Step 1).");
      }
      if (!host.trim()) throw new Error("Enter Modbus host.");
      const tmo = Math.min(60, Math.max(1, parseFloat(timeoutSec) || 5));
      const p = parseInt(port, 10) || 502;
      const u = parseInt(unitId, 10) || 1;
      const existing = await queryClient.fetchQuery({
        queryKey: ["points", sid],
        queryFn: () => apiFetch<Point[]>(`/points?site_id=${encodeURIComponent(sid)}`),
      });
      const existingIds = new Set(existing.map((pt) => pt.external_id));
      const seenInBatch = new Set<string>();
      const created: string[] = [];
      for (const r of rows) {
        const displayName = r.pointName.trim();
        const ext = toRuleExternalId(displayName);
        if (!ext) continue;
        if (seenInBatch.has(ext)) {
          throw new Error(
            `Duplicate name in this form: two rows resolve to point id "${ext}". Change one of the names.`,
          );
        }
        if (existingIds.has(ext)) {
          throw new Error(
            `Point "${ext}" already exists for this site. Change the name or edit the existing point on the Data model page.`,
          );
        }
        seenInBatch.add(ext);
        const addr = parseInt(r.address.trim(), 10);
        if (!Number.isFinite(addr) || addr < 0) continue;
        const count = parseInt((r.count || "1").trim(), 10) || 1;
        const cfg: Record<string, unknown> = {
          host: host.trim(),
          port: p,
          unit_id: u,
          timeout: tmo,
          address: addr,
          count,
          function: r.function,
        };
        if (r.decode) cfg.decode = r.decode;
        const sc = r.scale.trim();
        if (sc !== "" && !Number.isNaN(Number(sc))) cfg.scale = Number(sc);
        const off = r.offset.trim();
        if (off !== "" && !Number.isNaN(Number(off))) cfg.offset = Number(off);
        if (displayName) cfg.label = displayName;
        await createPoint({
          site_id: sid,
          external_id: ext,
          brick_type: null,
          fdd_input: ext,
          unit: r.unit.trim() || null,
          description: displayName || null,
          polling: true,
          modbus_config: cfg,
        });
        created.push(ext);
      }
      if (created.length === 0) {
        throw new Error(
          "Each row needs a point name (letters or numbers) and a valid Modbus address.",
        );
      }
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["points"] });
      queryClient.invalidateQueries({ queryKey: ["data-model"] });
    },
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Modbus TCP test bench</CardTitle>
          <p className="text-sm font-normal text-muted-foreground">
            Calls the BACnet gateway container&apos;s <code className="rounded bg-muted px-1 text-xs">POST /modbus/read_registers</code>{" "}
            (proxied as <code className="rounded bg-muted px-1 text-xs">POST /bacnet/modbus_read_registers</code>) with a batch{" "}
            <code className="rounded bg-muted px-1 text-xs">registers[]</code> payload. <strong>Add to data model</strong> writes one point per
            named row using flat <code className="rounded bg-muted px-1 text-xs">modbus_config</code> (host, address, count, function, …)-not the
            whole batch object on a single point. Uses the same gateway selector as BACnet tools. Polling uses the same scrape interval as BACnet
            when <code className="rounded bg-muted px-1 text-xs">modbus_config</code> is set on points.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-4">
            <div>
              <label htmlFor="modbus-site" className="mb-1 block text-xs font-medium text-muted-foreground">
                Site (for Add to data model)
              </label>
              <select
                id="modbus-site"
                value={siteId || (sites[0]?.id ?? "")}
                onChange={(e) => setSiteId(e.target.value)}
                className={`${fieldClass} min-w-[12rem]`}
                data-testid="modbus-client-site-select"
              >
                {sites.length === 0 ? (
                  <option value="">No sites - use BACnet tab Step 1</option>
                ) : (
                  sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div>
              <label htmlFor="modbus-host" className="mb-1 block text-xs font-medium text-muted-foreground">
                Host
              </label>
              <input
                id="modbus-host"
                className={`${monoClass} w-44`}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                data-testid="modbus-client-host"
              />
            </div>
            <div>
              <label htmlFor="modbus-port" className="mb-1 block text-xs font-medium text-muted-foreground">
                Port
              </label>
              <input
                id="modbus-port"
                type="number"
                className={`${fieldClass} w-24`}
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="modbus-unit" className="mb-1 block text-xs font-medium text-muted-foreground">
                Unit id
              </label>
              <input
                id="modbus-unit"
                type="number"
                className={`${fieldClass} w-24`}
                value={unitId}
                onChange={(e) => setUnitId(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="modbus-timeout" className="mb-1 block text-xs font-medium text-muted-foreground">
                Timeout (s)
              </label>
              <input
                id="modbus-timeout"
                type="number"
                className={`${fieldClass} w-24`}
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(e.target.value)}
              />
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-border/60">
            <div className="flex items-center justify-between border-b border-border/60 px-2 py-1.5">
              <p className="text-xs font-medium text-muted-foreground">Registers ({rows.length})</p>
              <button
                type="button"
                onClick={() => setRows((r) => [...r, defaultRow()])}
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-border/60 bg-muted/50 px-2 text-xs font-medium"
                data-testid="modbus-client-add-row"
              >
                <Plus className="h-3.5 w-3.5" />
                Add row
              </button>
            </div>
            <div className="space-y-3 p-3">
              {rows.map((row, idx) => (
                <div
                  key={idx}
                  className="grid gap-2 border-b border-border/40 pb-3 last:border-0 last:pb-0 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
                >
                  <div>
                    <label htmlFor={`modbus-client-address-${idx}`} className="mb-1 block text-xs text-muted-foreground">
                      address
                    </label>
                    <input
                      id={`modbus-client-address-${idx}`}
                      className={`${monoClass} w-full`}
                      value={row.address}
                      onChange={(e) => {
                        const v = e.target.value;
                        setRows((rs) => rs.map((x, i) => (i === idx ? { ...x, address: v } : x)));
                      }}
                      data-testid={idx === 0 ? "modbus-client-address-0" : undefined}
                    />
                  </div>
                  <div>
                    <label htmlFor={`modbus-client-count-${idx}`} className="mb-1 block text-xs text-muted-foreground">
                      count
                    </label>
                    <input
                      id={`modbus-client-count-${idx}`}
                      className={`${fieldClass} w-full`}
                      value={row.count}
                      onChange={(e) => {
                        const v = e.target.value;
                        setRows((rs) => rs.map((x, i) => (i === idx ? { ...x, count: v } : x)));
                      }}
                    />
                  </div>
                  <div>
                    <label htmlFor={`modbus-client-function-${idx}`} className="mb-1 block text-xs text-muted-foreground">
                      function
                    </label>
                    <select
                      id={`modbus-client-function-${idx}`}
                      className={`${fieldClass} w-full`}
                      value={row.function}
                      onChange={(e) => {
                        const v = e.target.value as "holding" | "input";
                        setRows((rs) => rs.map((x, i) => (i === idx ? { ...x, function: v } : x)));
                      }}
                    >
                      <option value="holding">holding</option>
                      <option value="input">input</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`modbus-client-decode-${idx}`} className="mb-1 block text-xs text-muted-foreground">
                      Decode
                    </label>
                    <select
                      id={`modbus-client-decode-${idx}`}
                      className={`${fieldClass} w-full`}
                      value={row.decode}
                      onChange={(e) => {
                        const v = e.target.value as ModbusDecodeValue;
                        setRows((rs) =>
                          rs.map((x, i) => {
                            if (i !== idx) return x;
                            let nextCount = x.count;
                            if (decodeNeedsTwoRegisters(v)) {
                              const n = parseInt((x.count || "1").trim(), 10) || 1;
                              if (n < 2) nextCount = "2";
                            }
                            return { ...x, decode: v, count: nextCount };
                          }),
                        );
                      }}
                      title="Must match the gateway; only these values are accepted."
                    >
                      {MODBUS_DECODE_VALUES.map((val) => (
                        <option key={val || "default"} value={val}>
                          {MODBUS_DECODE_LABELS[val]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor={`modbus-client-point-name-${idx}`} className="mb-1 block text-xs text-muted-foreground">
                      Point name
                    </label>
                    <input
                      id={`modbus-client-point-name-${idx}`}
                      className={`${fieldClass} w-full`}
                      placeholder="e.g. Main meter kW"
                      value={row.pointName}
                      onChange={(e) => {
                        const v = e.target.value;
                        setRows((rs) => rs.map((x, i) => (i === idx ? { ...x, pointName: v } : x)));
                      }}
                      data-testid={idx === 0 ? "modbus-client-point-name-0" : undefined}
                    />
                    {row.pointName.trim() ? (
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        Timeseries / rule id:{" "}
                        <code className="rounded bg-muted px-1">{toRuleExternalId(row.pointName) || "-"}</code>
                        {" · "}
                        BRICK class can be set later on the Data model page.
                      </p>
                    ) : null}
                  </div>
                  <div>
                    <label htmlFor={`modbus-client-unit-${idx}`} className="mb-1 block text-xs text-muted-foreground">
                      Unit (optional)
                    </label>
                    <input
                      id={`modbus-client-unit-${idx}`}
                      className={`${fieldClass} w-full`}
                      placeholder="e.g. kW, V"
                      value={row.unit}
                      onChange={(e) => {
                        const v = e.target.value;
                        setRows((rs) => rs.map((x, i) => (i === idx ? { ...x, unit: v } : x)));
                      }}
                    />
                  </div>
                  <div className="flex items-end gap-2 xl:col-span-1">
                    <div className="min-w-0 flex-1">
                      <span className="mb-1 block text-xs text-muted-foreground">scale / offset</span>
                      <div className="flex gap-1">
                        <input
                          id={`modbus-client-scale-${idx}`}
                          aria-label={`Scale row ${idx + 1}`}
                          className={`${fieldClass} w-16`}
                          placeholder="×"
                          value={row.scale}
                          onChange={(e) => {
                            const v = e.target.value;
                            setRows((rs) => rs.map((x, i) => (i === idx ? { ...x, scale: v } : x)));
                          }}
                        />
                        <input
                          id={`modbus-client-offset-${idx}`}
                          aria-label={`Offset row ${idx + 1}`}
                          className={`${fieldClass} w-16`}
                          placeholder="+"
                          value={row.offset}
                          onChange={(e) => {
                            const v = e.target.value;
                            setRows((rs) => rs.map((x, i) => (i === idx ? { ...x, offset: v } : x)));
                          }}
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label="Remove register row"
                      disabled={rows.length <= 1}
                      onClick={() => setRows((rs) => rs.filter((_, i) => i !== idx))}
                      className="inline-flex h-9 items-center rounded-lg border border-border/60 px-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => testMut.mutate()}
              disabled={testMut.isPending}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
              data-testid="modbus-client-run-test"
            >
              {testMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Network className="h-4 w-4" />}
              Run test bench
            </button>
            <button
              type="button"
              onClick={() => addMut.mutate()}
              disabled={addMut.isPending}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border/60 bg-muted/50 px-4 text-sm font-medium disabled:opacity-50"
              data-testid="modbus-client-add-to-model"
            >
              {addMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Add rows to data model
            </button>
          </div>
          {addMut.isError && (
            <p className="text-sm text-destructive" data-testid="modbus-client-add-error">
              {addMut.error instanceof Error ? addMut.error.message : String(addMut.error)}
            </p>
          )}
          {addMut.isSuccess && (
            <p className="text-sm text-muted-foreground" data-testid="modbus-client-add-success">
              Created points: {addMut.data.join(", ")}. Run data-model serialize or wait for graph sync.
            </p>
          )}

          <BacnetProxyResultView
            label="modbus_read_registers"
            data={testResGateway === gateway ? testRes : null}
          />
        </CardContent>
      </Card>
    </div>
  );
}
