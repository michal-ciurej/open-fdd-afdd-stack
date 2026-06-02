import { useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { FileDown, Wrench, X } from "lucide-react";
import { EngineerReport } from "./EngineerReport";
import type { EngineerReportEquipmentItem } from "./EngineerReport";

interface EngineerReportModalProps {
  items: EngineerReportEquipmentItem[];
  windowDays: number;
  siteId?: string;
  /** Shown in the report header — e.g. the site name. */
  subtitle?: string;
  onClose: () => void;
}

/** Body class consumed by the print-isolation rules in index.css. */
const PRINT_CLASS = "printing-engineer-report";

/**
 * Modal that frames the reusable {@link EngineerReport} with a header, close
 * control, and a "Download PDF" action that prints just the report region via
 * the browser's print dialog (Save as PDF).
 */
export function EngineerReportModal({
  items,
  windowDays,
  siteId,
  subtitle,
  onClose,
}: EngineerReportModalProps) {
  useEffect(() => {
    const cleanup = () => document.body.classList.remove(PRINT_CLASS);
    window.addEventListener("afterprint", cleanup);
    return () => {
      window.removeEventListener("afterprint", cleanup);
      cleanup();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handlePrint = useCallback(() => {
    document.body.classList.add(PRINT_CLASS);
    window.print();
  }, []);

  return createPortal(
    <div
      className="engineer-report-overlay fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Engineer report"
      onClick={onClose}
    >
      <div
        className="engineer-report-shell flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="engineer-report-modal"
      >
        <header className="engineer-report-modal-header flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-primary" />
            <div>
              <h2 className="text-lg font-semibold leading-tight">
                Engineer Planner
              </h2>
              {subtitle && (
                <p className="text-xs text-muted-foreground">{subtitle}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePrint}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              data-testid="engineer-report-download"
            >
              <FileDown className="h-4 w-4" />
              Download PDF
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="engineer-report-scroll overflow-y-auto px-5 py-5">
          <div id="engineer-report-print">
            <div className="mb-6 hidden print:block">
              <h1 className="text-xl font-semibold">Engineer Planner report</h1>
              {subtitle && (
                <p className="text-sm text-muted-foreground">{subtitle}</p>
              )}
            </div>
            <EngineerReport
              items={items}
              windowDays={windowDays}
              siteId={siteId}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
