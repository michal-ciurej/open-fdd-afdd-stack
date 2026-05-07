import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, RequireRole, useAuth } from "@/contexts/auth-context";
import { SiteProvider } from "@/contexts/site-context";
import { ThemeProvider } from "@/contexts/theme-context";
import { AppLayout } from "@/components/layout/AppLayout";
import { OverviewPage } from "@/components/pages/OverviewPage";
import { ConfigPage } from "@/components/pages/ConfigPage";
import { PointsPage } from "@/components/pages/PointsPage";
import { FaultsPage } from "@/components/pages/FaultsPage";
import { EquipmentPage } from "@/components/pages/EquipmentPage";
import { SystemResourcesPage } from "@/components/pages/SystemResourcesPage";
import { SiteConfigurationPage } from "@/components/pages/SiteConfigurationPage";
import { DataModelPage } from "@/components/pages/DataModelPage";
import { EnergyEngineeringPage } from "@/components/pages/EnergyEngineeringPage";
import { DataModelTestingPage } from "@/components/pages/DataModelTestingPage";
import { PlotsPage } from "@/components/pages/PlotsPage";
import { AnalyticsPage } from "@/components/pages/AnalyticsPage";
import { WeatherDataPage } from "@/components/pages/WeatherDataPage";
import { useWebSocket } from "@/hooks/use-websocket";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

function Forbidden() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-12 text-center">
      <h1 className="text-xl font-semibold">Not authorized</h1>
      <p className="text-sm text-muted-foreground">
        You don't have permission to view this page.
      </p>
    </div>
  );
}

function adminOnly(node: React.ReactNode) {
  return <RequireRole roles={["admin"]} fallback={<Forbidden />}>{node}</RequireRole>;
}
function engineerOrAdmin(node: React.ReactNode) {
  return (
    <RequireRole roles={["admin", "engineer"]} fallback={<Forbidden />}>
      {node}
    </RequireRole>
  );
}

function AppRoutes() {
  useWebSocket();

  return (
    <SiteProvider>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<OverviewPage />} />
          <Route path="config" element={adminOnly(<ConfigPage />)} />
          <Route path="site-configuration" element={adminOnly(<SiteConfigurationPage />)} />
          <Route path="bacnet-tools" element={<Navigate to="/site-configuration" replace />} />
          <Route path="equipment" element={<EquipmentPage />} />
          <Route path="points" element={adminOnly(<PointsPage />)} />
          <Route path="faults" element={<FaultsPage />} />
          <Route path="plots" element={<PlotsPage />} />
          <Route path="weather" element={adminOnly(<WeatherDataPage />)} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="diagnostics" element={<Navigate to="/analytics" replace />} />
          <Route path="system" element={adminOnly(<SystemResourcesPage />)} />
          <Route path="data-model" element={adminOnly(<DataModelPage />)} />
          <Route path="energy-engineering" element={engineerOrAdmin(<EnergyEngineeringPage />)} />
          <Route
            path="data-model-engineering"
            element={<Navigate to="/energy-engineering?tab=metadata" replace />}
          />
          <Route path="data-model-testing" element={engineerOrAdmin(<DataModelTestingPage />)} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SiteProvider>
  );
}

function AuthGate() {
  const { isLoading, user } = useAuth();
  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Signing you in…
      </div>
    );
  }
  // AuthProvider redirects to /login on 401; render nothing while that's in flight.
  if (!user) return null;
  return <AppRoutes />;
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <AuthGate />
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
