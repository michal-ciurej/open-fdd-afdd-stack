import { useState, useRef, useEffect, useMemo } from "react";
import { NavLink, useLocation, useSearchParams } from "react-router-dom";
import {
  LayoutDashboard,
  Settings,
  CircleDot,
  Boxes,
  AlertTriangle,
  LineChart,
  BarChart2,
  Zap,
  Cpu,
  Database,
  Search,
  Sun,
  ChevronUp,
  PlugZap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useHealth } from "@/hooks/use-fdd-status";
import { useActiveFaults } from "@/hooks/use-faults";
import { useConfig } from "@/hooks/use-config";
import { useAuth, type Role } from "@/contexts/auth-context";
import { timeAgo } from "@/lib/utils";
import { SiteSelector } from "./SiteSelector";

type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end: boolean;
  roles?: Role[]; // omit = visible to all signed-in users
};

const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/energy-engineering", label: "Energy Analysis", icon: Zap, end: false, roles: ["admin", "engineer"] },
  { to: "/equipment", label: "Equipment", icon: Boxes, end: false },
  { to: "/faults", label: "Faults", icon: AlertTriangle, end: false },
  { to: "/data-model-testing", label: "Building Model", icon: Search, end: false, roles: ["admin", "engineer"] },
  { to: "/plots", label: "Charting", icon: LineChart, end: false },
  { to: "/analytics", label: "Analytics", icon: BarChart2, end: false },
] as const;

// Entire Config submenu is admin-only.
const CONFIG_ITEMS: readonly NavItem[] = [
  { to: "/points", label: "Points", icon: CircleDot, end: false, roles: ["admin"] },
  { to: "/site-configuration", label: "Site Configuration", icon: PlugZap, end: false, roles: ["admin"] },
  { to: "/data-model", label: "Data Modelling", icon: Database, end: false, roles: ["admin"] },
  { to: "/weather", label: "Weather data", icon: Sun, end: false, roles: ["admin"] },
  { to: "/config", label: "System Config", icon: Settings, end: false, roles: ["admin"] },
  { to: "/system", label: "System resources", icon: Cpu, end: false, roles: ["admin"] },
] as const;



export function Sidebar() {
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const [healthOpen, setHealthOpen] = useState(false);
  const healthRef = useRef<HTMLDivElement>(null);
  const { data: health } = useHealth();
  const { data: config } = useConfig();
  const { data: faults } = useActiveFaults();
  const { hasRole } = useAuth();
  const visibleNav = useMemo(
    () => NAV_ITEMS.filter((i) => !i.roles || hasRole(...i.roles)),
    [hasRole],
  );
  const visibleConfig = useMemo(
    () => CONFIG_ITEMS.filter((i) => !i.roles || hasRole(...i.roles)),
    [hasRole],
  );
  const onConfigRoute = useMemo(
    () =>
      CONFIG_ITEMS.some(
        (i) => pathname === i.to || pathname.startsWith(`${i.to}/`),
      ),
    [pathname],
  );
  const [configOpen, setConfigOpen] = useState<boolean>(onConfigRoute);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (healthRef.current && !healthRef.current.contains(e.target as Node)) {
        setHealthOpen(false);
      }
    }
    if (healthOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [healthOpen]);

  // Auto-expand Config when navigating to a config route.
  useEffect(() => {
    if (onConfigRoute) setConfigOpen(true);
  }, [onConfigRoute]);

  const isHealthy = health?.status === "ok";
  const gs = health?.graph_serialization;
  const lastFdd = health?.last_fdd_run;
  const ruleHours = config?.rule_interval_hours;
  const weatherWithFdd = config?.open_meteo_enabled === true && typeof ruleHours === "number" && ruleHours > 0;
  const siteParam = searchParams.get("site");
  const search = siteParam ? `?site=${siteParam}` : "";

  return (
    <aside className="fdd-floating-pill-sidebar flex w-60 shrink-0 flex-col border border-border/60 bg-card/50">
      {/* Branding */}
      <div className="border-border/60 px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="text-lg font-semibold tracking-tight text-foreground">
            Servicer
          </span>
          <img src="/favicon.svg" alt="Servicer" className="h-10 w-10" />
        </div>
        <div className="mt-3">
          <SiteSelector />
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 px-3 py-2">
        {visibleNav.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={{ pathname: to, search }}
            end={end}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-150 ${
                isActive
                  ? "bg-muted/70 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              }`
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span>{label}</span>
            {label === "Faults" && faults && faults.length > 0 && (
              <Badge
                variant="destructive"
                className="ml-auto h-5 min-w-5 justify-center px-1.5 text-[10px]"
              >
                {faults.length}
              </Badge>
            )}
          </NavLink>
        ))}

        {visibleConfig.length > 0 && (
        <div className="pt-1">
          <button
            type="button"
            onClick={() => setConfigOpen((v) => !v)}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-150 ${
              onConfigRoute
                ? "bg-muted/70 font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            }`}
            aria-expanded={configOpen}
            aria-controls="sidebar-config-items"
          >
            <Settings className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-left">Config</span>
            <ChevronUp
              className={`h-4 w-4 shrink-0 transition-transform ${configOpen ? "" : "rotate-180"}`}
              aria-hidden="true"
            />
          </button>

          {configOpen && (
            <div id="sidebar-config-items" className="mt-1 space-y-0.5 pl-3">
              {visibleConfig.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={{ pathname: to, search }}
                  end={end}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-150 ${
                      isActive
                        ? "bg-muted/60 font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                    }`
                  }
                >
                  <Icon className="h-4 w-4 shrink-0 opacity-80" />
                  <span>{label}</span>
                </NavLink>
              ))}
            </div>
          )}
        </div>
        )}
      </nav>



      {/* Health indicator — click to open status details */}
      <div className="border-t border-border/60 px-5 py-3" ref={healthRef}>
        <button
          type="button"
          onClick={() => setHealthOpen(!healthOpen)}
          className="flex w-full items-center gap-2 text-xs text-left text-muted-foreground hover:text-foreground transition-colors"
          aria-expanded={healthOpen}
          aria-label="System status (click for details)"
        >
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${
              isHealthy
                ? "bg-success"
                : health
                  ? "bg-destructive"
                  : "bg-muted-foreground"
            }`}
            aria-hidden="true"
          />
          <span className="flex-1">
            {isHealthy
              ? "System healthy"
              : health
                ? "Unhealthy"
                : "Loading\u2026"}
          </span>
          <ChevronUp
            className={`h-3.5 w-3.5 shrink-0 transition-transform ${healthOpen ? "" : "rotate-180"}`}
            aria-hidden="true"
          />
        </button>
        {healthOpen && health && (
          <div
            className="mt-2 rounded-lg border border-border/60 bg-card p-3 text-xs shadow-lg"
            role="dialog"
            aria-label="System status details"
          >
            <p className="font-medium text-foreground mb-2">Status</p>
            <ul className="space-y-2 text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">API:</span>{" "}
                {health.status === "ok" ? "OK" : health.status}
              </li>
              {lastFdd?.run_ts && (
                <li>
                  <span className="font-medium text-foreground">Last FDD run:</span>{" "}
                  {timeAgo(lastFdd.run_ts)}
                  {weatherWithFdd && " (includes weather)"}
                  {lastFdd.sites_processed != null && ` · ${lastFdd.sites_processed} sites, ${lastFdd.faults_written ?? 0} faults`}
                </li>
              )}
              {gs && (
                <li>
                  <span className="font-medium text-foreground">RDF serialization:</span>{" "}
                  {gs.last_ok ? "OK" : "Error"}
                  {gs.last_serialization_at && ` · ${timeAgo(gs.last_serialization_at)}`}
                  {gs.last_error && (
                    <span className="block mt-0.5 text-destructive truncate" title={gs.last_error}>
                      {gs.last_error}
                    </span>
                  )}
                  {gs.path_resolved && (
                    <span className="block mt-0.5 text-muted-foreground/80 truncate" title={gs.path_resolved}>
                      {gs.path_resolved}
                    </span>
                  )}
                </li>
              )}
            </ul>
          </div>
        )}
      </div>
    </aside>
  );
}
