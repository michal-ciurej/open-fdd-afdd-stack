import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { PageShell } from "@/components/ui/page-shell";

/**
 * Per-dashboard background image. Drop files in frontend/public/data/images/ — the
 * paths below are served from there at runtime. When the file is missing the page just
 * shows the green gradient wash with no image. Add new routes here when added in App.tsx.
 */
const PAGE_BACKGROUNDS: Record<string, string> = {
  "/": "/data/images/overview.jpg",
  "/config": "/data/images/config.jpg",
  "/site-configuration": "/data/images/site-configuration.jpg",
  "/points": "/data/images/points.jpg",
  "/faults": "/data/images/faults.jpg",
  "/plots": "/data/images/plots.jpg",
  "/weather": "/data/images/weather.jpg",
  "/analytics": "/data/images/analytics.jpg",
  "/system": "/data/images/system.jpg",
  "/data-model": "/data/images/data-model.jpg",
  "/energy-engineering": "/data/images/energy-engineering.jpg",
  "/data-model-testing": "/data/images/data-model-testing.jpg",
};

function backgroundFor(pathname: string): string | undefined {
  if (PAGE_BACKGROUNDS[pathname]) return PAGE_BACKGROUNDS[pathname];
  for (const [route, img] of Object.entries(PAGE_BACKGROUNDS)) {
    if (route !== "/" && pathname.startsWith(`${route}/`)) return img;
  }
  return undefined;
}

export function AppLayout() {
  const { pathname } = useLocation();
  const fullWidthContent = pathname === "/plots" || pathname === "/weather";
  const backgroundImage = backgroundFor(pathname);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-y-auto">
          <PageShell backgroundImage={backgroundImage}>
            <div
              className={
                fullWidthContent
                  ? "w-full px-6 py-8"
                  : "mx-auto max-w-7xl px-6 py-8"
              }
            >
              <Outlet />
            </div>
          </PageShell>
        </main>
      </div>
    </div>
  );
}
