# Generic Open-FDD LAN testing

Use this when OpenClaw needs to test Open-FDD on **any** reachable LAN or VPN, not just the current bench.

Goal: make the first pass useful even when you do **not** have SSH, `.env`, or local log access.

## Inputs to collect first

- host or IP (required)
- whether the target is expected to be **HTTP** or **self-signed TLS**
- whether API/docs should be public, auth-gated, or loopback-only
- whether bearer tokens or UI credentials are available

If those answers are missing, still run the generic probes and label the unknowns clearly.

## Minimal probe set

For host `HOST`:

### HTTP-first checks
- `http://HOST/`
- `http://HOST:8000/health`
- `http://HOST:8000/docs`
- `http://HOST:8080/docs`
- `http://HOST:5173/`
- `http://HOST:8880/`

### TLS-first checks
- `https://HOST/` with insecure/self-signed allowance when needed
- `https://HOST/api/health`
- `http://HOST/` to see whether it redirects to HTTPS

## Interpretation guide

### Standard HTTP shape
Likely when you observe:
- `http://HOST/` returns `200`
- `https://HOST/` fails or is irrelevant
- `:8000/health` from the client returns `200`
- `:8000/docs` returns `200` when docs are enabled

Interpretation:
- operator path is likely plain HTTP
- direct API exposure may be intentional in this mode

### Self-signed TLS shape
Likely when you observe:
- `https://HOST/` returns `200` with `-k` / insecure cert allowance
- `https://HOST/api/health` returns `200`
- `http://HOST/` returns `301` or `302`
- direct `:8000/health` from the client fails while the app still works through Caddy

Interpretation:
- operator path is likely HTTPS through Caddy
- direct API failure from the client may be expected because of loopback binding

### Auth-gated but alive
Typical signs:
- `401` or `403` on docs or API routes
- frontend still loads
- health or edge route proves the service exists

Interpretation:
- do not call this service down
- classify as auth-gated unless contrary evidence exists

## Reporting shape

Keep the report short:

1. **Access level:** host-aware or edge-only
2. **Observed mode:** HTTP, TLS, mixed/unclear
3. **Operator URL today:** one line
4. **Client probe table:** URL → code → note
5. **Unknowns:** what you still need from the human
6. **Next concrete check:** one specific file/log/endpoint, not generic debugging

## Reusable scripts

Use one of:
- `openclaw/scripts/probe_openfdd_lan.sh`
- `openclaw/scripts/probe_openfdd_lan.ps1`

Both are parameterized by host and intended for reuse across buildings and benches.

## Do not overclaim

Without SSH or host logs, avoid claiming:
- exact Caddyfile in use
- exact `.env` binds
- whether a loopback-only API is intentional vs accidental

Say what is observed from the client and what host-side evidence would settle the ambiguity.
