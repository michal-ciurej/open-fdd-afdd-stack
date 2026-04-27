import { useState } from "react";
import { Link } from "react-router-dom";
import { NiagaraConfigPanel } from "@/components/niagara/NiagaraConfigPanel";
import { IQVisionConfigPanel } from "@/components/iqvision/IQVisionConfigPanel";
import { SitesSetupCard } from "@/components/site/SitesSetupCard";
import { BacnetToolsPage } from "@/components/pages/BacnetToolsPage";

type Connector = "niagara" | "iqvision" | "bacnet";

export function SiteConfigurationPage() {
  const [connector, setConnector] = useState<Connector>("niagara");

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight" data-testid="site-config-heading">
        Site Configuration
      </h1>
      <p className="mb-6 max-w-3xl text-sm text-muted-foreground">
        Configure how points flow into this stack from each site. <strong>Niagara</strong> and{" "}
        <strong>IQVision</strong> are the primary BQL-based connectors: one endpoint per site, scan the
        station for control points, then sync history on a schedule. <strong>BACnet &amp; Modbus</strong>{" "}
        remain available for direct gateway work and edge discovery. Export and tagging tools live on the{" "}
        <Link to="/data-model" className="font-medium text-primary underline-offset-4 hover:underline">
          Data model
        </Link>{" "}
        page.
      </p>

      <SitesSetupCard className="mb-6" />

      <div
        className="mb-4 flex flex-wrap gap-2 border-b border-border/60 pb-3"
        role="tablist"
        aria-label="Data connectors"
      >
        <button
          type="button"
          role="tab"
          aria-selected={connector === "niagara"}
          onClick={() => setConnector("niagara")}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
            connector === "niagara"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted/60"
          }`}
          data-testid="site-config-section-niagara"
        >
          Niagara
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={connector === "iqvision"}
          onClick={() => setConnector("iqvision")}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
            connector === "iqvision"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted/60"
          }`}
          data-testid="site-config-section-iqvision"
        >
          IQVision
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={connector === "bacnet"}
          onClick={() => setConnector("bacnet")}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
            connector === "bacnet"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted/60"
          }`}
          data-testid="site-config-section-bacnet"
        >
          BACnet &amp; Modbus
        </button>
      </div>

      {connector === "niagara" && <NiagaraConfigPanel />}
      {connector === "iqvision" && <IQVisionConfigPanel />}
      {connector === "bacnet" && <BacnetToolsPage />}
    </div>
  );
}
