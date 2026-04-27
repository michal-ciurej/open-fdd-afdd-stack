# Stack — build, compose, restart

This directory contains the `docker-compose.yml`, Dockerfiles, SQL init scripts, Caddy config, Grafana provisioning, and rule YAML for the full Open-FDD platform. Run every command below from the `stack/` directory unless noted.

## Services

| Service | Container | Image / Build | Role | Profile |
|---|---|---|---|---|
| `db` | `openfdd_timescale` | `timescale/timescaledb:latest-pg16` | TimescaleDB — canonical store for points, readings, faults, metadata. Initialised from `sql/*.sql` on first boot. | core |
| `api` | `openfdd_api` | `Dockerfile.api` | FastAPI CRUD + realtime WebSocket. Binds `127.0.0.1:8000` by default (`OFDD_API_HOST_BIND`). | core |
| `frontend` | `openfdd_frontend` | `node:22-alpine` | Vite build + `vite preview` on `:5173`. Rebuilds on every start (bind-mounted `../frontend`). | core |
| `bacnet-server` | `openfdd_bacnet_server` | `../../diy-bacnet-server/Dockerfile` | BACnet/IP gateway, JSON-RPC on `:8080` (`network_mode: host`). | core |
| `bacnet-scraper` | `openfdd_bacnet_scraper` | `Dockerfile.bacnet_scraper` | Polls BACnet RPC, writes readings to DB. | core |
| `weather-scraper` | `openfdd_weather_scraper` | `Dockerfile.weather_scraper` | Open-Meteo fetch loop (24h default). | core |
| `fdd-loop` | `openfdd_fdd_loop` | `Dockerfile.fdd_loop` | Runs YAML rules every `OFDD_RULE_INTERVAL_HOURS`, writes `fault_results`. | core |
| `host-stats` | `openfdd_host_stats` | `Dockerfile.hoststats` | Mem/load/docker stats → `host_metrics`, `container_metrics`. | core |
| `caddy` | `openfdd_caddy` | `caddy:2` | Optional reverse proxy + Basic auth (`:80`/`:443`/`:8880`). | core (optional) |
| `grafana` | `openfdd_grafana` | `grafana/grafana:latest` | Dashboards on `:3000`. | `grafana` |
| `mcp-rag` | `openfdd_mcp_rag` | `Dockerfile.mcp_rag` | MCP retrieval service on `:8090`. | `mcp-rag` |
| `mosquitto` | `openfdd_mosquitto` | `eclipse-mosquitto:2` | MQTT broker for BACnet2MQTT / remote collection. | `mqtt` |

Profiles are opt-in: pass `--profile grafana --profile mcp-rag --profile mqtt` to `docker compose` to include them.

## Prerequisites

1. Docker + Docker Compose v2.
2. `diy-bacnet-server` checked out as a sibling of `open-fdd-afdd-stack/` (compose builds from `../../diy-bacnet-server`). Omit `bacnet-server` + `bacnet-scraper` if you don't need local BACnet.
3. [stack/.env](.env) — created by `scripts/bootstrap.sh` or hand-written. Relevant vars: `OFDD_API_KEY`, `OFDD_APP_USER`, `OFDD_APP_USER_HASH`, `OFDD_JWT_SECRET`, `OFDD_BACNET_SERVER_API_KEY`, `VITE_API_BASE`, `OFDD_API_HOST_BIND`, `OFDD_FRONTEND_HOST_BIND`, retention / log knobs.
4. [frontend/.env](../frontend/.env) — required if you build the frontend on the host (e.g. for CI or local debugging). For the lab stack set `VITE_API_BASE=http://localhost:8000`. Behind Caddy use `/api`. Vite **bakes this into the bundle at build time** — a missing value produces a frontend that silently falls back to relative URLs and cannot reach the API.

## First-time setup

```bash
cd stack
cp .env.example .env            # if using the template; otherwise run scripts/bootstrap.sh
docker compose build            # build every core image
docker compose up -d            # start core services; DB init scripts run on first boot
```

`sql/*.sql` files in [sql/](sql/) are executed by the TimescaleDB entrypoint **only on first boot** when the `openfdd_db` volume is empty. Schema changes to an existing volume must be applied manually — see *Applying SQL migrations* below.

## Build

Rebuild all images that use a local Dockerfile:

```bash
docker compose build
```

Rebuild a single service:

```bash
docker compose build api
docker compose build bacnet-scraper fdd-loop host-stats weather-scraper mcp-rag
```

The `frontend` service uses the stock `node:22-alpine` image and rebuilds the Vite bundle on every container start (the entrypoint runs `npm ci` if `node_modules` is empty, then `npm run build`, then `vite preview`). No `docker compose build` step is needed for frontend changes — a `docker compose restart frontend` (or `up -d frontend`) is enough.

### Building the frontend on the host (optional)

Useful when iterating without Docker:

```bash
cd frontend
npm ci
VITE_API_BASE=http://localhost:8000 npm run build
npm run preview -- --host 0.0.0.0 --port 5173
```

The `frontend/.env` file pins `VITE_API_BASE` so subsequent host builds don't break. `vite preview` **does not honour** the `proxy:` field in `vite.config.ts` — only `vite dev` does.

## Compose / start

```bash
docker compose up -d                              # core only
docker compose --profile grafana up -d            # + Grafana
docker compose --profile grafana --profile mcp-rag --profile mqtt up -d   # everything
```

Check status + health:

```bash
docker compose ps
docker compose logs -f api frontend
```

## Restart

Restart a single service (no rebuild):

```bash
docker compose restart api
```

Rebuild + recreate a single service (picks up code / Dockerfile changes):

```bash
docker compose up -d --build api
```

Recreate every service (image changes, env changes, compose edits):

```bash
docker compose up -d --build
```

Hard stop + start (keeps volumes / data):

```bash
docker compose down
docker compose up -d
```

`down -v` would delete the `openfdd_db`, `grafana_data`, and `frontend_node_modules` volumes — **do not run it** unless you intend to wipe the database.

## Applying SQL migrations

DB init scripts only run on an empty volume. For schema changes on a running stack, pipe the file into `psql`:

```bash
docker compose exec -T db psql -U postgres -d openfdd -f - < sql/020_niagara_sites.sql
```

Repeat per migration file. Scripts are written to be idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).

## Verification

```bash
curl -sf http://localhost:8000/health                 # → {"ok": true, ...}
curl -sf http://localhost:8000/openapi.json | jq '.paths | keys | map(select(startswith("/niagara")))'
curl -sfI http://localhost:5173/                      # frontend
docker compose ps                                     # all services "Up" / "(healthy)"
```

If the frontend loads but API calls return 500 / fail in the browser console, the bundle was built without `VITE_API_BASE`. Rebuild the frontend container:

```bash
docker compose up -d --force-recreate frontend
```

## Common workflows

Backend code change → rebuild API image → recreate:

```bash
docker compose up -d --build api
```

Rule YAML edit (`stack/rules/*.yaml`): picked up on the next `fdd-loop` tick — no restart needed. Force an immediate run by touching `config/.run_fdd_now`.

Frontend code change: `docker compose restart frontend` (the entrypoint rebuilds).

Adding a new Python dependency: edit `pyproject.toml`, rebuild every image that bundles the package (`api`, `fdd-loop`, `bacnet-scraper`, `weather-scraper`, `host-stats`, `mcp-rag`).

New SQL migration: add file to `sql/`, apply via `psql` on the running stack (see above), and commit — it'll run automatically on a fresh volume.

## Logs & retention

All services use `json-file` logging with rotation driven by `OFDD_LOG_MAX_SIZE` (default `100m`) and `OFDD_LOG_MAX_FILES` (default `3`) from `stack/.env`. TimescaleDB retention lives in the SQL init scripts (`OFDD_RETENTION_DAYS`).
