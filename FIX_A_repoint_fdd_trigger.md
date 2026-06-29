# Implementation guideline — Fix A: re-point the "Run FDD now" button

**Audience:** the implementing agent. **Branch:** `azureVersion`.
**Type:** frontend-only change. **No deployment steps** — a separate monitoring agent owns the build/roll/verify on Azure. Do **not** run `az`, build images, or deploy. Just make the code change, run the frontend test suite, and hand back.

---

## 1. Why this change

The current button is a silent no-op on the Azure deployment:

- Button → `triggerFddRun()` → `POST /api/run-fdd`, which only **touches a trigger file** (`config/.run_fdd_now`).
- That file is read **only** by `run_rule_loop` when launched with `--loop` (a 60s polling loop).
- On ACA, `predmain-fdd-loop` is a **one-shot Schedule job** (`run_rule_loop` **without** `--loop`, cron `0 */3 * * *`). Nothing is running to read the file. The POST returns `200 {"status":"triggered"}`, the UI says "Loop will pick up within ~60s", and **no FDD run ever happens** except on the 3-hour cron.

**Fix:** re-point the button to `POST /api/jobs/fdd/run`, which runs `run_fdd_loop()` **in-process inside the `predmain-api` container** (the API image bakes `stack/rules`, mounts `data_model.ttl`, and has DB access). Then surface live status to the user.

No backend change is required — `POST /jobs/fdd/run` and `GET /jobs/{id}` already exist in the deployed API (`openfdd_stack/platform/api/jobs.py`).

---

## 2. CRITICAL design constraint — do not poll `GET /jobs/{id}` naively

`predmain-api` runs `minReplicas:1, maxReplicas:3` with default HTTP autoscaling. The job store (`openfdd_stack/platform/jobs.py` `_JOB_STORE`) is an **in-memory dict per replica**. If ACA scales out, the `POST /jobs/fdd/run` may land on replica A while a later `GET /jobs/{job_id}` is routed to replica B → **`404 Job not found`**, even though the run is fine.

**Therefore: drive the UI's progress/completion off the DB-backed status endpoint, not the in-memory job store.**

- Use `POST /jobs/fdd/run` only as the **trigger** (fire-and-forget; the returned `job_id` is for logging/telemetry, not required for completion detection).
- Detect progress/completion by polling the existing **`GET /run-fdd/status`** (`useFddStatus`, query key `["fdd-status"]`), which reads `fdd_run_log` from Postgres and is replica-independent. `run_fdd_loop()` writes a `fdd_run_log` row at the end of every run (status `ok` **or** `error`).

Completion = a `last_run.run_ts` **newer** than the timestamp captured at trigger time. (Accept the minor edge case that a concurrent cron firing could advance `run_ts` first — that still means a fresh run completed; good enough for this UX.)

> If the team later pins `predmain-api` to `maxReplicas:1`, polling `GET /jobs/{id}` for richer live status (queued→running, immediate `faults_written`, explicit `error` string) becomes safe. That is an infra decision for the monitoring agent — out of scope here. Default to the DB-status approach above.

---

## 3. Exact changes

### 3.1 `frontend/src/lib/crud-api.ts`

Re-point `triggerFddRun` (currently ~lines 491–496) to the jobs endpoint. Keep the return type as the job-create shape.

```ts
import type { JobCreateResponse } from "@/types/api";

/** POST /jobs/fdd/run - run FDD now, in-process in the API container. Returns a job_id.
 *  Completion is detected via GET /run-fdd/status (DB-backed), not the in-memory job store
 *  (the API may run >1 replica; the job store is per-replica). */
export function triggerFddRun() {
  return apiFetch<JobCreateResponse>("/jobs/fdd/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}", // FddRunJobBody is empty; send {} so Content-Type is satisfied
  });
}
```

> Leave the old `/run-fdd` route and its `run_fdd/status` consumer alone otherwise — `GET /run-fdd/status` is still used by `useFddStatus` and must stay.

### 3.2 `frontend/src/types/api.ts`

Add types mirroring `openfdd_stack/platform/api/schemas.py` (`JobCreateResponse`, `JobResponse`):

```ts
/** POST /jobs/* response (mirrors backend JobCreateResponse). */
export interface JobCreateResponse {
  job_id: string;
  status: string; // "queued"
}

/** GET /jobs/{job_id} response (mirrors backend JobResponse). Not required for
 *  completion detection (see crud-api triggerFddRun note) but typed for telemetry. */
export interface JobResponse {
  job_id: string;
  job_type: string;
  status: "queued" | "running" | "finished" | "failed";
  created_at: string;
  updated_at?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
}
```

### 3.3 `frontend/src/components/pages/FddRulesPage.tsx` — `FddLoopStatusSection`

Rework the trigger so it (a) fires the job, (b) shows a live "Running…" state, (c) refreshes the Last-run card + faults when a newer run lands.

Current relevant code: `triggerMutation` (~lines 501–506), the button (~lines 543–564), and `lastRun` from `useFddStatus` (~line 508).

Implement this behaviour:

1. **On trigger:** capture the current `lastRun?.run_ts` into local state as `baselineRunTs`, then `triggerMutation.mutate()`. Set a local `isRunning = true`.
2. **While running:** force `useFddStatus` to poll fast. Either:
   - bump its `refetchInterval` to ~3–5s while `isRunning` (preferred — add an optional arg to `useFddStatus`, see 3.4), or
   - add a dedicated `useQuery(["fdd-status"], … , { refetchInterval: isRunning ? 4000 : 60000 })` local to this component.
3. **Completion:** when `lastRun.run_ts` becomes newer than `baselineRunTs`, set `isRunning = false`, then:
   - if `lastRun.status === "ok"`: show success (e.g. `Run complete — {faults_written} fault rows written`).
   - else: show `lastRun.status` as an error/destructive badge.
   - `queryClient.invalidateQueries({ queryKey: ["faults"] })` (and `["analytics"]` if present) so downstream pages refresh.
4. **Button disabled** while `triggerMutation.isPending || isRunning`. Label: `Triggering…` → `Running…` → idle `Run FDD now`.
5. **Timeout guard:** if no newer `run_ts` after ~3 minutes, stop the spinner and show "Run started; status not yet confirmed — check the Faults page" (a run is ~1–2 min; this just prevents a stuck spinner).
6. **Copy/title fix:** the button `title` currently reads `POST /run-fdd - touches trigger file; loop picks it up within 60s` and the success line says `Triggered. Loop will pick up within ~60s.` Replace both — they describe the broken mechanism. New title e.g. `POST /jobs/fdd/run — runs FDD now in the API container`. New success copy reflects in-process completion (see step 3).

Keep the existing `data-testid="fdd-run-now-button"` on the button (a test depends on it — see §4).

### 3.4 (Optional, if you chose 3.3 step 2 first option) `frontend/src/hooks/use-fdd-status.ts`

Allow a caller-supplied refetch interval:

```ts
export function useFddStatus(refetchMs: number = 60_000) {
  return useQuery<FddRunStatus>({
    queryKey: ["fdd-status"],
    queryFn: () => apiFetch<FddRunStatus>("/run-fdd/status"),
    refetchInterval: refetchMs,
  });
}
```

(`use-system.ts` also exports a `useFddStatus`? No — it's only here. The duplicate `useCapabilities` in this file is pre-existing; leave it.)

---

## 4. Tests & checks (run locally; do NOT deploy)

- `cd frontend && npm run lint && npx tsc --noEmit && npm run test` (or the project's `vitest` script). Fix any type errors from the new interfaces.
- If a test references the trigger (search for `fdd-run-now-button` and `triggerFddRun`), update its mock from `POST /run-fdd` to `POST /jobs/fdd/run` and the new status-polling completion flow. Preserve the `data-testid`.
- Manual smoke is the monitoring agent's job after deploy; you do not need a live backend.

## 5. Acceptance criteria

- Clicking "Run FDD now" issues `POST /api/jobs/fdd/run` (verify in the network tab / test mock), not `/api/run-fdd`.
- The button shows a running state and resolves to success/error based on a **new** `fdd_run_log` row (via `GET /run-fdd/status`), not the in-memory job store.
- No reliance on `GET /jobs/{id}` for completion (avoids the multi-replica 404).
- Lint, typecheck, and unit tests pass.

## 6. Out of scope / do not touch

- **No deployment.** No `az`, no `az acr build`, no `swa deploy`, no `containerapp` commands. The monitoring agent rolls `predmain-api` (already has the endpoint) + the frontend and verifies live.
- Do not remove the `/run-fdd` backend route or `GET /run-fdd/status` (the status endpoint is still used).
- Do not change the ACA job's `--loop` flag, cron, or the `predmain-fdd-loop`/`predmain-nightly-sync` images. (A separate, larger fix could move FDD execution to a real job-start via managed identity, but that's blocked by subscription RBAC and is not Fix A.)
- Do not change API replica scaling here — if `GET /jobs/{id}` polling is desired instead, raise it with the monitoring agent to pin `maxReplicas:1` first.

## 7. Handback

Report: files changed, test output, and confirmation that the trigger now calls `/jobs/fdd/run` with DB-backed completion. The monitoring agent will then build/roll/verify on Azure.
