import { StationEndpointsPanel } from "@/components/station/StationEndpointsPanel";
import {
  createNiagaraEndpoint,
  deleteNiagaraEndpoint,
  listNiagaraEndpoints,
  listNiagaraPoints,
  startNiagaraScan,
  startNiagaraSync,
  testNiagaraEndpoint,
  updateNiagaraEndpoint,
} from "@/lib/crud-api";

// Niagara bqltime keywords are lowercase (bqltime.lastweek). The default
// window below must match one of these values.
const BQL_WINDOWS = [
  "today",
  "yesterday",
  "lastweek",
  "thisweek",
  "weektodate",
  "lastmonth",
  "thismonth",
] as const;

export function NiagaraConfigPanel() {
  return (
    <StationEndpointsPanel
      driverKey="niagara"
      driverLabel="Niagara"
      baseUrlPlaceholder="https://station.local"
      groupingHint={
        <>
          Scans discover control points via BQL; equipment is grouped from the nav ORD folder
          twice removed. Syncs pull history for points carrying an{" "}
          <code className="rounded bg-muted px-1 text-xs">n:history</code> tag. Enable{" "}
          <strong>Poll points</strong> to also scrape live values each poll cycle (only points
          with <strong>Polling</strong> on are read).
        </>
      }
      bqlWindows={BQL_WINDOWS}
      defaultWindow="lastweek"
      supportsPolling
      api={{
        listEndpoints: listNiagaraEndpoints,
        createEndpoint: createNiagaraEndpoint,
        updateEndpoint: updateNiagaraEndpoint,
        deleteEndpoint: deleteNiagaraEndpoint,
        testEndpoint: testNiagaraEndpoint,
        startScan: startNiagaraScan,
        startSync: startNiagaraSync,
        listPoints: listNiagaraPoints,
      }}
    />
  );
}
