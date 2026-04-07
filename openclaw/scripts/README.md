# OpenClaw lab scripts

Small host-side helpers for OpenClaw work. Prefer repo-root `./scripts/bootstrap.sh` for stack operations.

## Existing helpers

| Script | Purpose |
|--------|---------|
| `capture_bootstrap_log.sh` | Run `./scripts/bootstrap.sh` with args you pass; tee to `openclaw/logs/bootstrap-test-<ts>.txt`; activate `.venv` if present. |
| `verify_with_log.sh` | Run `./scripts/bootstrap.sh --verify` with a captured log. |

## Generic LAN probes

| Script | Purpose |
|--------|---------|
| `probe_openfdd_lan.sh` | Bash probe for any Open-FDD host/IP. Tests HTTP, TLS, API, docs, raw frontend, and alternate Caddy port without hardcoding a specific bench. |
| `probe_openfdd_lan.ps1` | PowerShell version of the same generic LAN probe for Windows operators and OpenClaw hosts. |

Use these when OpenClaw does **not** have SSH to the Open-FDD host and only has client-side network reachability.
