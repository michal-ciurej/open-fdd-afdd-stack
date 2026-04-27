import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { SiteProvider } from "@/contexts/site-context";
import { ThemeProvider } from "@/contexts/theme-context";
import { AppLayout } from "@/components/layout/AppLayout";
import { OverviewPage } from "@/components/pages/OverviewPage";
import { ConfigPage } from "@/components/pages/ConfigPage";
import { PointsPage } from "@/components/pages/PointsPage";
import { FaultsPage } from "@/components/pages/FaultsPage";
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

function AppRoutes() {
  useWebSocket();

  return (
    <SiteProvider>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<OverviewPage />} />
          <Route path="config" element={<ConfigPage />} />
          <Route path="site-configuration" element={<SiteConfigurationPage />} />
          <Route path="bacnet-tools" element={<Navigate to="/site-configuration" replace />} />
          <Route path="equipment" element={<Navigate to="/config" replace />} />
          <Route path="points" element={<PointsPage />} />
          <Route path="faults" element={<FaultsPage />} />
          <Route path="plots" element={<PlotsPage />} />
          <Route path="weather" element={<WeatherDataPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="diagnostics" element={<Navigate to="/analytics" replace />} />
          <Route path="system" element={<SystemResourcesPage />} />
          <Route path="data-model" element={<DataModelPage />} />
          <Route path="energy-engineering" element={<EnergyEngineeringPage />} />
          <Route
            path="data-model-engineering"
            element={<Navigate to="/energy-engineering?tab=metadata" replace />}
          />
          <Route path="data-model-testing" element={<DataModelTestingPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SiteProvider>
  );
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
