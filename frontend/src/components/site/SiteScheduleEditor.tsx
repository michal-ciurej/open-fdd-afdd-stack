"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Save } from "lucide-react";
import { useSiteSchedule, useUpdateSiteSchedule } from "@/hooks/use-site-schedule";
import type { SiteScheduleEntry } from "@/types/api";

const inputBase =
  "h-9 rounded-lg border border-border/60 bg-background px-3 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring";

// dow uses ISO numbering 0=Mon..6=Sun (matches site_schedules / occupancy mask).
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DEFAULT_TZ = "Europe/London";

type DayRow = {
  enabled: boolean;
  start: string; // HH:MM
  end: string; // HH:MM
};

const EMPTY_DAY: DayRow = { enabled: false, start: "07:00", end: "19:00" };

/** "07:00:00" | "07:00" -> "07:00" for <input type="time">. */
function toHhMm(t: string): string {
  return t.slice(0, 5);
}

function blankWeek(): DayRow[] {
  return DAY_LABELS.map(() => ({ ...EMPTY_DAY }));
}

function diffHours(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return (eh * 60 + em - (sh * 60 + sm)) / 60;
}

/**
 * Per-site weekly core-occupancy editor backed by `site_schedules`. Replaces the
 * old "core occupancy hrs/year" scalar: the schedule is the source of truth and
 * the FDD loop / energy profiling derive in-hours masks and annual hours from it.
 */
export function SiteScheduleEditor({ siteId }: { siteId: string }) {
  const { data, isLoading } = useSiteSchedule(siteId);
  const update = useUpdateSiteSchedule(siteId);

  const [days, setDays] = useState<DayRow[]>(blankWeek);
  const [tz, setTz] = useState(DEFAULT_TZ);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  // Hydrate local state from the loaded schedule.
  useEffect(() => {
    if (!data) return;
    const next = blankWeek();
    for (const e of data.entries) {
      if (e.dow < 0 || e.dow > 6) continue;
      next[e.dow] = {
        enabled: true,
        start: toHhMm(e.start_local),
        end: toHhMm(e.end_local),
      };
    }
    setDays(next);
    setTz(data.entries[0]?.tz ?? DEFAULT_TZ);
  }, [data]);

  const weeklyHours = useMemo(
    () =>
      days.reduce(
        (sum, d) => (d.enabled ? sum + Math.max(0, diffHours(d.start, d.end)) : sum),
        0,
      ),
    [days],
  );
  const annualHours = Math.round((weeklyHours * 365.25) / 7);

  function patchDay(idx: number, patch: Partial<DayRow>) {
    setSavedOk(false);
    setDays((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  }

  function applyWeekdaysFromMonday() {
    setSavedOk(false);
    setDays((prev) => {
      const mon = prev[0];
      return prev.map((d, i) =>
        i <= 4 ? { ...mon } : d,
      );
    });
  }

  async function handleSave() {
    setError(null);
    setSavedOk(false);

    const entries: SiteScheduleEntry[] = [];
    for (let dow = 0; dow < 7; dow++) {
      const d = days[dow];
      if (!d.enabled) continue;
      if (diffHours(d.start, d.end) <= 0) {
        setError(`${DAY_LABELS[dow]}: end time must be after start time.`);
        return;
      }
      entries.push({
        dow,
        start_local: `${d.start}:00`,
        end_local: `${d.end}:00`,
        tz: tz.trim() || DEFAULT_TZ,
      });
    }

    try {
      await update.mutateAsync({ entries });
      setSavedOk(true);
    } catch (e) {
      setError((e as Error).message ?? "Failed to save schedule");
    }
  }

  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <CalendarClock className="h-4 w-4" />
        Core occupancy schedule
      </h3>
      <p className="mb-3 text-xs text-muted-foreground/80">
        Weekly operating hours per day in local time. The FDD loop and energy
        profiling use this to tell in-hours from out-of-hours.
      </p>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading schedule…</p>
      ) : (
        <div className="space-y-2">
          {days.map((d, idx) => (
            <div key={idx} className="flex flex-wrap items-center gap-3">
              <label className="flex w-24 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={d.enabled}
                  onChange={(e) => patchDay(idx, { enabled: e.target.checked })}
                  data-testid={`schedule-day-${idx}-enabled`}
                />
                <span className="font-medium">{DAY_LABELS[idx]}</span>
              </label>
              <input
                type="time"
                value={d.start}
                disabled={!d.enabled}
                onChange={(e) => patchDay(idx, { start: e.target.value })}
                className={`${inputBase} w-28 disabled:opacity-40`}
                data-testid={`schedule-day-${idx}-start`}
              />
              <span className="text-muted-foreground">to</span>
              <input
                type="time"
                value={d.end}
                disabled={!d.enabled}
                onChange={(e) => patchDay(idx, { end: e.target.value })}
                className={`${inputBase} w-28 disabled:opacity-40`}
                data-testid={`schedule-day-${idx}-end`}
              />
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={applyWeekdaysFromMonday}
              className="rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/80"
              data-testid="schedule-apply-weekdays"
            >
              Copy Mon to Mon–Fri
            </button>
            <div>
              <label className="mr-2 text-xs font-medium text-muted-foreground">
                Timezone
              </label>
              <input
                type="text"
                value={tz}
                onChange={(e) => {
                  setSavedOk(false);
                  setTz(e.target.value);
                }}
                placeholder="Europe/London"
                className={`${inputBase} w-48`}
                data-testid="schedule-tz"
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground/80" data-testid="schedule-hours-summary">
            {weeklyHours.toFixed(1)} h/week · ≈{annualHours.toLocaleString()} h/year
          </p>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={update.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              data-testid="schedule-save-button"
            >
              <Save className="h-4 w-4" />
              {update.isPending ? "Saving…" : "Save schedule"}
            </button>
            {savedOk && !error && (
              <span className="text-xs text-muted-foreground" data-testid="schedule-save-ok">
                Saved.
              </span>
            )}
            {error && (
              <p className="text-sm text-destructive" data-testid="schedule-save-error">
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
