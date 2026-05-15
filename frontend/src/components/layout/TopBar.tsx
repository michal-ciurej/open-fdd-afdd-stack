import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Sun, Moon } from "lucide-react";
import { useFddStatus } from "@/hooks/use-fdd-status";
import { useActiveFaults } from "@/hooks/use-faults";
import { useTheme } from "@/contexts/theme-context";
import { TutorialPopover } from "@/components/ui/tutorial-popover";
import { cn, timeAgo } from "@/lib/utils";

function ActiveFaultCounter() {
  const { data: faults } = useActiveFaults();
  const count = faults?.length ?? 0;
  const hasFaults = count > 0;
  const label =
    count === 0
      ? "No active faults"
      : `${count} active fault${count === 1 ? "" : "s"}`;

  return (
    <TutorialPopover
      title={hasFaults ? "Active faults" : "All clear"}
      meaning="Number of equipment × fault rows currently flagged across the stack."
      status="Click to open the Faults page."
      side="bottom"
    >
      <Link
        to="/faults"
        className={cn(
          "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
          hasFaults
            ? "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20"
            : "border-success/30 bg-success/10 text-success hover:bg-success/20",
        )}
        aria-label={label}
        data-testid="topbar-fault-counter"
      >
        {hasFaults ? (
          <AlertTriangle className="h-4 w-4" aria-hidden />
        ) : (
          <CheckCircle2 className="h-4 w-4" aria-hidden />
        )}
        <span className="tabular-nums">{label}</span>
      </Link>
    </TutorialPopover>
  );
}

export function TopBar() {
  const { data: fddStatus } = useFddStatus();
  const { theme, setTheme } = useTheme();
  const lastRun = fddStatus?.last_run;
  const isDark =
    theme === "dark" ||
    (theme === "system" && typeof document !== "undefined" && document.documentElement.classList.contains("dark"));

  return (
    <header className="fdd-floating-pill-topbar relative z-30 flex h-14 shrink-0 items-center justify-between gap-4 border border-border/60 bg-card/80 px-6 backdrop-blur-lg">
      {/* Left: FDD + Weather status (mirrors operator mental model) */}
      <div className="flex min-w-0 items-center gap-4 text-sm text-muted-foreground">
        {lastRun ? (

            <span className="cursor-help">
              last check: <span className="font-medium text-foreground">{timeAgo(lastRun.run_ts)}</span>
            </span>
        ) : (            <span className="cursor-help">No Checks yet</span>

)}
      </div>

      {/* Right: active-fault counter + theme toggle */}
      <div className="flex items-center gap-3">
        <ActiveFaultCounter />
        <TutorialPopover
          title={isDark ? "Light mode" : "Dark mode"}
          meaning="Toggle between light and dark theme for the UI. Your preference is stored in the browser."
          status="Click to switch."
          side="bottom"
        >
          <button
            type="button"
            onClick={() => setTheme(isDark ? "light" : "dark")}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </TutorialPopover>
      </div>
    </header>
  );
}
