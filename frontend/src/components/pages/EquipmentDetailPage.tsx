import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  ArrowLeft,
  Cpu,
  Gauge,
  AlertTriangle,
  Activity,
  Eye,
  EyeOff,
  Zap,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSiteContext } from "@/contexts/site-context";
import { useAllEquipment, useAllPoints } from "@/hooks/use-sites";
import { useFaultDefinitions, useSiteFaults } from "@/hooks/use-faults";
import { DataQueryWidget } from "@/components/dashboard/DataQueryWidget";
import { FaultOverTimeChart } from "@/components/dashboard/FaultOverTimeChart";
import { EquipmentEnergyTab } from "@/components/equipment/EquipmentEnergyTab";
import { updateEquipment } from "@/lib/crud-api";
import { severityVariant, timeAgo, cn, isEquipmentObserved } from "@/lib/utils";
import { faultAppliesToDevice } from "./fault-matrix-utils";
import type {
  Equipment,
  FaultDefinition,
  FaultState,
} from "@/types/api";

type DetailTab = "overview" | "energy" | "points";
const TAB_KEYS: DetailTab[] = ["overview", "energy", "points"];

function isTab(value: string | null): value is DetailTab {
  return value !== null && (TAB_KEYS as string[]).includes(value);
}

type ChartPreset = "7d" | "30d";

function matchingFaultDefinitions(
  equipment: Equipment,
  definitions: FaultDefinition[],
): FaultDefinition[] {
  return definitions.filter((def) =>
    faultAppliesToDevice(def, {
      site_id: equipment.site_id,
      site_name: "",
      bacnet_device_id: "",
      equipment_id: equipment.id,
      equipment_name: equipment.name,
      equipment_type: equipment.equipment_type,
    }),
  );
}

function presetWindow(preset: ChartPreset): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  if (preset === "7d") start.setDate(start.getDate() - 7);
  else start.setDate(start.getDate() - 30);
  return { start: start.toISOString(), end: end.toISOString() };
}

interface ChartTogglePillProps {
  value: ChartPreset;
  onChange: (next: ChartPreset) => void;
}

/** Two-state pill toggle, visually consistent with DateRangeSelect. */
function ChartTogglePill({ value, onChange }: ChartTogglePillProps) {
  const options: { value: ChartPreset; label: string }[] = [
    { value: "7d", label: "7 d" },
    { value: "30d", label: "30 d" },
  ];
  return (
    <div className="inline-flex h-9 items-center gap-1 rounded-lg bg-muted/70 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex items-center justify-center rounded-md px-3 py-1 text-xs font-medium transition-all duration-200",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            value === o.value
              ? "bg-card text-foreground shadow-sm shadow-black/[0.04]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface ActiveFaultsCardProps {
  equipmentId: string;
  faults: FaultState[];
  definitions: FaultDefinition[];
  isLoading: boolean;
}

function ActiveFaultsCard({
  equipmentId,
  faults,
  definitions,
  isLoading,
}: ActiveFaultsCardProps) {
  const defMap = useMemo(
    () => new Map(definitions.map((d) => [d.fault_id, d])),
    [definitions],
  );
  const equipmentFaults = useMemo(
    () => faults.filter((f) => f.equipment_id === equipmentId && f.active),
    [faults, equipmentId],
  );

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4" />
          Active faults ({isLoading ? "…" : equipmentFaults.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 p-0">
        {isLoading ? (
          <div className="px-6 py-4">
            <Skeleton className="h-32 w-full rounded-lg" />
          </div>
        ) : equipmentFaults.length === 0 ? (
          <div className="px-6 py-6 text-sm text-muted-foreground">
            No active faults on this equipment.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fault</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead className="text-right">Since</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {equipmentFaults.map((f) => {
                const def = defMap.get(f.fault_id);
                const severity = def?.severity ?? "warning";
                return (
                  <TableRow key={f.id}>
                    <TableCell>
                      <div className="font-medium">
                        {def?.name ?? f.fault_id}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {f.fault_id}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={severityVariant(severity)}>
                        {severity}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {timeAgo(f.last_changed_ts)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ObservationToggle({ equipment }: { equipment: Equipment }) {
  const queryClient = useQueryClient();
  const observed = isEquipmentObserved(equipment);
  const mutation = useMutation({
    mutationFn: (nextObserved: boolean) =>
      updateEquipment(equipment.id, { metadata: { observed: nextObserved } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["equipment"] });
    },
  });

  return (
    <button
      type="button"
      onClick={() => mutation.mutate(!observed)}
      disabled={mutation.isPending}
      title={observed ? "Stop tracking this equipment on the overview page" : "Track fault frequency on the overview page"}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
        observed
          ? "border-warning/30 bg-warning/10 text-warning-foreground hover:bg-warning/20"
          : "border-border/60 bg-background text-muted-foreground hover:bg-muted",
      )}
      data-testid="observation-toggle"
      aria-pressed={observed}
    >
      {observed ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
      {observed ? "Under observation" : "Mark for observation"}
    </button>
  );
}

interface FaultsChartCardProps {
  equipment: Equipment;
  definitions: FaultDefinition[];
}

function FaultsChartCard({ equipment, definitions }: FaultsChartCardProps) {
  const [preset, setPreset] = useState<ChartPreset>("7d");
  const { start, end } = useMemo(() => presetWindow(preset), [preset]);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4" />
          Faults over time
        </CardTitle>
        <ChartTogglePill value={preset} onChange={setPreset} />
      </CardHeader>
      <CardContent className="flex-1 px-3 pb-3">
        <FaultOverTimeChart
          siteId={equipment.site_id}
          definitions={definitions}
          preset={preset}
          start={start}
          end={end}
          bucket="day"
          equipmentIds={[equipment.id]}
          height={240}
        />
      </CardContent>
    </Card>
  );
}

export function EquipmentDetailPage() {
  const { equipmentId } = useParams<{ equipmentId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { setSelectedSiteId } = useSiteContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab: DetailTab = isTab(tabParam) ? tabParam : "overview";

  const setActiveTab = (next: DetailTab) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        if (next === "overview") params.delete("tab");
        else params.set("tab", next);
        return params;
      },
      { replace: true },
    );
  };

  const { data: equipmentList = [], isLoading: equipmentLoading } = useAllEquipment();
  const { data: allPoints = [] } = useAllPoints();
  const { data: definitions = [] } = useFaultDefinitions();

  const equipment = useMemo(
    () => equipmentList.find((e) => e.id === equipmentId),
    [equipmentList, equipmentId],
  );

  const { data: siteFaults = [], isLoading: faultsLoading } = useSiteFaults(
    equipment?.site_id,
  );

  const equipmentPoints = useMemo(
    () => allPoints.filter((p) => p.equipment_id === equipmentId),
    [allPoints, equipmentId],
  );

  const matchingFaults = useMemo(
    () => (equipment ? matchingFaultDefinitions(equipment, definitions) : []),
    [equipment, definitions],
  );

  if (equipmentLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-64 rounded" />
        <Skeleton className="h-48 w-full rounded-2xl" />
      </div>
    );
  }

  if (!equipment) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">Equipment not found.</p>
        <button
          type="button"
          onClick={() => navigate(`/equipment${location.search}`)}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border/60 bg-background px-3 text-sm font-medium transition-colors hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to equipment
        </button>
      </div>
    );
  }

  const equipmentLink = `/equipment${location.search}`;

  return (
    <div>
      <nav
        aria-label="Breadcrumb"
        className="mb-3 flex items-center gap-1.5 text-sm text-muted-foreground"
      >
        <Link
          to={equipmentLink}
          onClick={() => setSelectedSiteId(equipment.site_id)}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Equipment
        </Link>
        <ChevronRight className="h-4 w-4 text-muted-foreground/60" aria-hidden />
        <span className="font-medium text-foreground">{equipment.name}</span>
      </nav>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{equipment.name}</h1>
        <div className="flex items-center gap-2">
          {equipment.equipment_type && (
            <Badge variant="outline" className="font-mono text-xs">
              {equipment.equipment_type}
            </Badge>
          )}
          <ObservationToggle equipment={equipment} />
        </div>
      </div>

      <div
        className="mb-6 flex flex-wrap gap-2 border-b border-border/60 pb-3"
        role="tablist"
        aria-label="Equipment detail sections"
      >
        {[
          { value: "overview" as const, label: "Overview", icon: Cpu },
          { value: "energy" as const, label: "Energy", icon: Zap },
          { value: "points" as const, label: "Points", icon: Gauge },
        ].map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={activeTab === value}
            onClick={() => setActiveTab(value)}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              activeTab === value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted/60",
            )}
            data-testid={`equipment-tab-${value}`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {activeTab === "overview" && (
        <>
          <div className="mb-6 grid gap-5 lg:grid-cols-3">
            <Card className="flex h-full flex-col">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Cpu className="h-4 w-4" />
                  Details
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 space-y-2 text-sm">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Brick type</span>
                  <span className="font-mono text-xs">
                    {equipment.equipment_type ?? "—"}
                  </span>
                </div>
                {equipment.description && (
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Description</span>
                    <span className="text-right">{equipment.description}</span>
                  </div>
                )}
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Points</span>
                  <span className="tabular-nums">{equipmentPoints.length}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Matching rules</span>
                  <span className="tabular-nums">{matchingFaults.length}</span>
                </div>
              </CardContent>
            </Card>

            <ActiveFaultsCard
              equipmentId={equipment.id}
              faults={siteFaults}
              definitions={definitions}
              isLoading={faultsLoading}
            />

            <FaultsChartCard equipment={equipment} definitions={definitions} />
          </div>

          <Card className="mb-6">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4" />
                Matching fault rules ({matchingFaults.length})
              </CardTitle>
              <p className="text-sm font-normal text-muted-foreground">
                Rules that apply to this equipment&apos;s Brick type and will be
                evaluated on each FDD run.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              {matchingFaults.length === 0 ? (
                <div className="px-6 py-6 text-sm text-muted-foreground">
                  No fault rules match this equipment&apos;s type.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fault</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Applies to</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {matchingFaults.map((def) => (
                      <TableRow key={def.fault_id}>
                        <TableCell>
                          <div className="font-medium">{def.name}</div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {def.fault_id}
                          </div>
                          {def.description && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              {def.description}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={severityVariant(def.severity)}>
                            {def.severity}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {def.category}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {def.equipment_types && def.equipment_types.length > 0
                            ? def.equipment_types.join(", ")
                            : "all equipment"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <DataQueryWidget siteId={equipment.site_id} equipmentId={equipment.id} />
        </>
      )}

      {activeTab === "energy" && (
        <EquipmentEnergyTab
          equipmentId={equipment.id}
          equipmentName={equipment.name}
          equipmentType={equipment.equipment_type ?? null}
        />
      )}

      {activeTab === "points" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Gauge className="h-4 w-4" />
              Points ({equipmentPoints.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {equipmentPoints.length === 0 ? (
              <div className="px-6 py-6 text-sm text-muted-foreground">
                No points are assigned to this equipment.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Brick type</TableHead>
                    <TableHead>FDD input</TableHead>
                    <TableHead>Unit</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {equipmentPoints.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">
                        {p.object_name ?? p.external_id}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {p.brick_type ?? "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {p.fdd_input ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {p.unit ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
