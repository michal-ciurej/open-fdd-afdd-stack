# Frontend (React) testing notes

## Human-like smoke

1. Open the real operator URL first.
2. Navigate to primary routes (dashboard, faults, plots, data-model/testing pages if present).
3. Note blank screens, obvious API errors, redirect loops, login failures, and console failures.

## URL discipline

Do not assume raw `:5173` is the real operator path.

- In HTTP mode, operator path may be `http://HOST/` or `http://HOST:8880/`.
- In self-signed TLS mode, operator path should be `https://HOST/`.
- `http://HOST:5173/` may serve static frontend content without the Caddy `/api` proxy behavior.

## Client-first checks when SSH is unavailable

Use the generic LAN probes first:
- `openclaw/references/generic_lan_testing.md`
- `openclaw/scripts/probe_openfdd_lan.sh`
- `openclaw/scripts/probe_openfdd_lan.ps1`

## Automation in this repo

- Vitest runs in CI / `./scripts/bootstrap.sh --test`.
- Selenium / E2E lives under `openclaw/bench/e2e/`.
- AI/data-model payload tests are often better signal than brittle click-path assertions when the mission is new-building modeling help.

## Reporting

Record:
- route / URL tested
- expected vs actual
- whether the test used operator URL or raw frontend URL
- one-line browser console note if relevant
- auth state if known

Put durable notes in `issues_log.md`; keep screenshots small and non-sensitive.
