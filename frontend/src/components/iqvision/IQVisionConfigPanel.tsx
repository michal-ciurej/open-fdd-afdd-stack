import { StationEndpointsPanel } from "@/components/station/StationEndpointsPanel";
import {
  createIQVisionEndpoint,
  deleteIQVisionEndpoint,
  listIQVisionEndpoints,
  listIQVisionPoints,
  startIQVisionScan,
  startIQVisionSync,
  testIQVisionEndpoint,
  updateIQVisionEndpoint,
} from "@/lib/crud-api";

const BQL_WINDOWS = [
  "today",
  "yesterday",
  "lastWeek",
  "thisWeek",
  "weektodate",
  "lastMonth",
  "thisMonth",
] as const;

export function IQVisionConfigPanel() {
  return (
    <StationEndpointsPanel
      driverKey="iqvision"
      driverLabel="IQVision"
      baseUrlPlaceholder="https://iqvision.local"
      groupingHint={
        <>
          Same BQL scan + history shape as Niagara; equipment is grouped by the BQL{" "}
          <code className="rounded bg-muted px-1 text-xs">Device</code> column
          (<code className="rounded bg-muted px-1 text-xs">proxyExt.device.displayName</code>).
        </>
      }
      bqlWindows={BQL_WINDOWS}
      defaultWindow="weektodate"
      api={{
        listEndpoints: listIQVisionEndpoints,
        createEndpoint: createIQVisionEndpoint,
        updateEndpoint: updateIQVisionEndpoint,
        deleteEndpoint: deleteIQVisionEndpoint,
        testEndpoint: testIQVisionEndpoint,
        startScan: startIQVisionScan,
        startSync: startIQVisionSync,
        listPoints: listIQVisionPoints,
      }}
    />
  );
}
