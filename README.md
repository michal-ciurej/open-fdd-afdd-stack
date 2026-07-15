Fault Finding

[![Discord](https://img.shields.io/badge/Discord-Join%20Server-5865F2.svg?logo=discord&logoColor=white)](https://discord.gg/Ta48yQF8fC)
[![CI](https://github.com/PredMain/PredMain-afdd-stack/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/PredMain/PredMain-afdd-stack/actions/workflows/ci.yml)
![MIT License](https://img.shields.io/badge/license-MIT-green.svg)
![Development Status](https://img.shields.io/badge/status-Beta-blue)
![Python](https://img.shields.io/badge/Python-3.9+-blue?logo=python&logoColor=white)
[![Engine (PyPI)](https://img.shields.io/pypi/v/PredMain?label=engine%20(PyPI))](https://pypi.org/project/PredMain/)

<div align="center">



</div>

PredMain is an open-source knowledge graph fault-detection platform for HVAC systems that helps facilities optimize their energy usage and cost-savings. Because it runs on-prem, facilities never have to worry about a vendor hiking prices, going dark, or walking away with their data. The platform is an AFDD stack designed to run inside the building, behind the firewall, under the owner’s control. It transforms operational data into actionable, cost-saving insights and provides a secure integration layer that any cloud platform can use without vendor lock-in. U.S. Department of Energy research reports median energy savings of roughly 8–9% from FDD programs-meaningful annual savings depending on facility size and energy spend.

The content that used to live here is now **`afdd_stack/`** in **[PredMain/PredMain](https://github.com/PredMain/PredMain)**. The README below is **legacy**; prefer the monorepo. The **rules engine** is still **[`PredMain` on PyPI](https://pypi.org/project/PredMain/)**.


---

 Documentation


* 📖 **[Stack Docs](https://PredMain.github.io/PredMain-afdd-stack/)** - bootstrap, Docker, API, drivers, React UI
* 📘 **[Engine Docs](https://PredMain.github.io/PredMain/)** - RuleRunner, YAML rules, pandas ([repo](https://github.com/PredMain/PredMain), [`PredMain` PyPI](https://pypi.org/project/PredMain/))
* 📕 **[PDF Docs](https://github.com/PredMain/PredMain/blob/master/pdf/PredMain-docs.pdf)** - offline build: `python3 scripts/build_docs_pdf.py`
* ✨ **[LLM Workflow](https://PredMain.github.io/PredMain-afdd-stack/modeling/llm_workflow#copy-paste-prompt-template-recommended)** - export → tag → import
* 🤖 **[Open-Claw](https://PredMain.github.io/PredMain-afdd-stack/openclaw_integration)** - model context, MCP, API workflows

---

 Quick Starts

 PredMain Engine-only (rules engine, no Docker) PyPi

If you only want the Python rules engine (without the full platform stack), you can use it in standard Python environments.

```bash
pip install PredMain
```


 PredMain AFDD Platform Manually by the Human

PredMain uses Docker and Docker Compose to orchestrate and manage all platform services within a unified containerized environment. The bootstrap script (`./scripts/bootstrap.sh`) is **Linux-only** and intended for IoT edge applications using Docker exclusively.

 Debian / Ubuntu setup

- **Git:** Install Git if needed, e.g. `sudo apt update && sudo apt install git`.
- **Docker:** Follow the official guide to install Docker Engine (and Compose): [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/).

 Prerequisites (Ubuntu / Debian-style)

After Docker is installed, add your Linux user to the **`docker`** group so you can run `docker` without `sudo` (log out and back in, or use `newgrp`, for the group change to apply):

```bash
sudo usermod -aG docker "$USER"
newgrp docker
docker ps
```

Create a Python virtual environment and install **`argon2-cffi`** (used to hash passwords for bootstrap):

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install argon2-cffi
```

Clone the repository:

```bash
git clone https://github.com/PredMain/PredMain.git
```

 Standard HTTP bootstrap (no TLS) and app login

The `--bacnet-address` value is the static bind address for BACnet, which is the usual setup for BACnet/IP on operations technology (OT) LANs. Bootstrap supports **dual-NIC** hosts: use this address on the OT interface; your other interface can use DHCP for outbound internet access.

```bash
cd PredMain-afdd-stack

printf '%s' 'YourSecurePassword' | ./scripts/bootstrap.sh \
  --bacnet-address 192.168.204.16/24:47808 \
  --bacnet-instance 12345 \
  --user ben \
  --password-stdin
```


 Standard hardened stack - self-signed TLS (Caddy) and app login

PredMain runs over TLS with self-signed certificates, and there is no access to the PredMain API or the DIY BACnet server Docker container APIs.


```bash
cd PredMain-afdd-stack

printf '%s' 'YourSecurePassword' | ./scripts/bootstrap.sh \
  --bacnet-address 192.168.204.16/24:47808 \
  --bacnet-instance 12345 \
  --user ben \
  --password-stdin \
  --caddy-self-signed
```

 Bootstrap Troubleshooting

```bash
./scripts/bootstrap.sh --doctor
```

Also available is the **partial stack** mode: `./scripts/bootstrap.sh --mode collector`, `--mode model`, or `--mode engine`. See the `Docs` below for more information.

 Run tests (`--test`)

Use the same bootstrap script for local verification (no separate CI recipe required on the machine):

```bash
cd PredMain-afdd-stack
./scripts/bootstrap.sh --test
```

This runs frontend lint, TypeScript `tsc`, Vitest, backend `pytest`, and Caddyfile validation when Docker is available. If Docker is missing or the daemon is not usable, Caddy validation is skipped; frontend and backend tests still run when Node/npm and Python (with dev deps) are available.

Optional one-shot creation of `.venv` and `pip install -e ".[dev]"` when `pytest` is not installed:

```bash
OFDD_BOOTSTRAP_INSTALL_DEV=1 ./scripts/bootstrap.sh --test
```

Combine with health checks: `./scripts/bootstrap.sh --verify --test`.

---

 Python layout


Local development (co-developing engine + stack) and push to a new or existing development branch:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -e "/path/to/PredMain[dev]"
pip install -e ".[dev]"
pytest openfdd_stack/tests -v
```

---

 License

MIT

---

 Azure deployment

This section documents the **per-change deploy workflow** for the production Azure tenant. For the one-time infrastructure build-out (resource groups, ACR, ACA environment, SWA, Postgres Flex Server, secrets, Entra App Roles), see [docs/deployment-azure.md](docs/deployment-azure.md).

 What lives where

| Artifact | Type | Built with | Deployed to |
|---|---|---|---|
| `predmain-api` | Docker image (`3msecontainers.azurecr.io/predmain-api`) | `az acr build -f stack/Dockerfile.api` | ACA container app `predmain-api`. Public ingress; SWA forwards `/api/*` to it. |
| `predmain-fdd-loop` | Docker image (`3msecontainers.azurecr.io/predmain-fdd-loop`) | `az acr build -f stack/Dockerfile.fdd_loop` | **Two** ACA Jobs sharing this image: `predmain-fdd-loop` (rule loop, cron `0 */3 * * *`) and `predmain-nightly-sync` (history sync, cron `0 3 * * *`). They differ only in the command override. |
| `predmain-frontend` | Static React bundle | `npm run build:swa` (frontend/) | Azure Static Web Apps `predmain-frontend`, environment `production`. |

**Rule storage (single source of truth).** In cloud, rule YAML lives on the shared `predmain-config` Azure Files mount as `rules/*.yaml` — the same read-write share (mounted at `/app/config`) that holds `data_model.ttl`, so `predmain-api` and both jobs read and write **one** physical copy at `/app/config/rules`. Set `OFDD_RULES_DIR=/app/config/rules` (**absolute**, mirroring the `OFDD_BRICK_TTL_PATH=/app/config/data_model.ttl` convention) on all three containers — an absolute path always lands on the mount regardless of working directory. The `stack/rules/*.yaml` still baked into each image (`COPY stack/rules ./stack/rules`) is now only the **dev default and a one-time seed**: on first boot the API/loop seeds an empty `config/rules` from the baked-in defaults (`ensure_rules_dir_seeded`), then treats the share as authoritative and never overwrites it. Consequence: **tuning a rule param no longer needs an image rebuild** — edit the YAML on the share (or via the Faults page → *Sync definitions*) and it is picked up on the next FDD run, exactly as the UI displays it. Rebuild the image only to change the *baked-in defaults* used for a fresh share. See [rule storage](docs/rules/overview.md) and [deployment](docs/deployment-azure.md#42-fdd-loop-image-shared-by-predmain-fdd-loop-and-predmain-nightly-sync).

 Prerequisites

- `az login` on the Pay-As-You-Go subscription (Entra tenant `fce6e120-a4ac-468f-bce8-0a9efa296639`).
- **PowerShell 7+** on Windows for the build/roll commands.
- **Node 18+** for the frontend build.
- A clean working tree (image tags are short git SHAs - see *Pre-flight* below).
- The `.dockerignore` at the repo root is **required**. Without it every `az acr build` uploads ~200 MB of `frontend/node_modules` and ~15 MB of `.git` as build context. Keep it committed.

 One-shot workflow

The full cycle is: **commit → build images → roll API → roll both jobs → build + deploy frontend → verify**. 

 0. Pre-flight

```powershell
git status                              # tree must be clean - image tags are SHAs
$SHA = git rev-parse --short HEAD
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$BASE = '3msecontainers.azurecr.io/python:3.14-slim'   # base image pulled from ACR, not Docker Hub
```

Tags are pinned to short git SHAs (`predmain-api:c6d8dec`). Tagging an image with a SHA whose code isn't actually in the image is a footgun - rollbacks then lie. If you have to publish uncommitted work, tag with `dev-<UTC stamp>` instead and re-tag once you commit.

> **One-time: mirror the base image into ACR.** ACR build agents pull the `FROM` base from Docker Hub **anonymously**, which hits Docker's pull rate limit (`toomanyrequests: You have reached your unauthenticated pull rate limit`) and fails the build. Both Dockerfiles take a `BASE_IMAGE` build-arg (default `python:3.14-slim` for local builds) so cloud builds can pull the base from ACR instead. Import it once (re-run only when bumping the Python version):
> ```powershell
> az acr import -n 3mseContainers --source docker.io/library/python:3.14-slim --image python:3.14-slim
> # If the import itself is rate-limited, authenticate with any Docker Hub account + PAT:
> #   az acr import -n 3mseContainers --source docker.io/library/python:3.14-slim --image python:3.14-slim --username <user> --password <PAT>
> ```

 1. Build the two backend images (run in parallel)

```powershell
# API image
az acr build -r 3mseContainers `
  -t "predmain-api:$SHA" -t predmain-api:latest `
  --build-arg BASE_IMAGE=$BASE `
  --no-logs -f stack/Dockerfile.api .

# fdd-loop image (used by BOTH predmain-fdd-loop and predmain-nightly-sync)
az acr build -r 3mseContainers `
  -t "predmain-fdd-loop:$SHA" -t predmain-fdd-loop:latest `
  --build-arg BASE_IMAGE=$BASE `
  --no-logs -f stack/Dockerfile.fdd_loop .
```

> **Why `--build-arg BASE_IMAGE=$BASE`?** It points `FROM` at the ACR-mirrored base (see the one-time import above) so the build agent pulls it from `3msecontainers.azurecr.io` - where it's already authenticated - instead of anonymously from Docker Hub. Omitting it falls back to the Docker Hub default and risks the `toomanyrequests` failure. Local `docker build` needs no arg; the Dockerfile default handles it.

> **Why `--no-logs`?** On Windows the `az` CLI streams ACR build logs through `colorama`, which writes via `cp1252` and crashes on common build output even when `$env:PYTHONIOENCODING = 'utf-8'` is set. The remote ACR build still succeeds, but the local `az` process exits `1`, which is misleading. `--no-logs` skips the streaming path; `az` still waits for the build to finish and returns a real exit code. Inspect logs after the fact with `az acr task list-runs` + `az acr task logs --runner <runId>`, or via Log Analytics KQL on `ContainerAppConsoleLogs_CL`. **Don't rely on the older `PYTHONIOENCODING` workaround alone** - it's not enough when `az` runs with a captured pipe rather than a real console.

Confirm both tags landed:

```powershell
az acr repository show-tags -n 3mseContainers --repository predmain-api      --orderby time_desc --top 3 -o tsv
az acr repository show-tags -n 3mseContainers --repository predmain-fdd-loop --orderby time_desc --top 3 -o tsv
```

 2. Roll the API container app

```powershell
az containerapp update -g Live_Services -n predmain-api `
  --image "3msecontainers.azurecr.io/predmain-api:$SHA" `
  --revision-suffix "api$SHA"

# Wait for the new revision to go Healthy before continuing.
az containerapp revision show -g Live_Services -n predmain-api `
  --revision "predmain-api--api$SHA" `
  --query '{p:properties.provisioningState, h:properties.healthState, r:properties.runningState}' -o json
```

Single-revision mode is the default - the new revision takes 100% of ingress automatically when it reports `Healthy`.

 3. Roll **both** jobs in lockstep

```powershell
az containerapp job update -g Live_Services -n predmain-fdd-loop `
  --image "3msecontainers.azurecr.io/predmain-fdd-loop:$SHA"
az containerapp job update -g Live_Services -n predmain-nightly-sync `
  --image "3msecontainers.azurecr.io/predmain-fdd-loop:$SHA"

# Test each before the next cron firing.
az containerapp job start -g Live_Services -n predmain-fdd-loop
az containerapp job start -g Live_Services -n predmain-nightly-sync

# Confirm both succeeded.
az containerapp job execution list -g Live_Services --name predmain-fdd-loop `
  --query '[0].{status:properties.status, end:properties.endTime}' -o table
az containerapp job execution list -g Live_Services --name predmain-nightly-sync `
  --query '[0].{status:properties.status, end:properties.endTime}' -o table
```

> **⚠ Critical:** `predmain-nightly-sync` and `predmain-fdd-loop` share one image and differ only in the command override. **Always update both in lockstep.** Historically, updating one without the other left `predmain-nightly-sync` pointing at an image that didn't contain `run_nightly_sync.py`, which silently failed every night for two weeks before anyone noticed.

 4. Build and deploy the frontend

```powershell
Set-Location frontend

# Vite build + injects tenant GUID into dist/staticwebapp.config.json
$env:AAD_TENANT_ID = 'fce6e120-a4ac-468f-bce8-0a9efa296639'
npm run build:swa

# Deploy
$SWA_TOKEN = az staticwebapp secrets list -g Live_Services -n predmain-frontend `
  --query properties.apiKey -o tsv
npx -y '@azure/static-web-apps-cli@latest' deploy ./dist `
  --deployment-token $SWA_TOKEN --env production

Set-Location ..
```

> Quote `'@azure/...@latest'` in PowerShell - a bare leading `@` is the splat operator otherwise.

After deploy, **hard-refresh** (Ctrl+Shift+R) or test in incognito. SWA serves the JS bundle with cache headers; browsers keep the old bundle otherwise.

 5. Verify

- **API:** open a page that exercises a recently-changed endpoint and check the network tab.
- **Rules / fdd-loop:** the smoke-start in step 3 should have written new rows to `fault_results`. Open the Faults page in the SPA.
- **Nightly-sync:** confirm a new row in `point_readings` from each Niagara/IQVision-backed site, dated within the configured `--window` (default `yesterday`). For a longer catch-up, override args once: `az containerapp job start -g Live_Services -n predmain-nightly-sync --args="--window lastweek"`.
- **Frontend:** hard-refresh and exercise the new feature. Screens behind a new role/permission require sign-out + sign-in (incognito) - Entra tokens are minted at sign-in and hold stale claims for up to 1h.

 Order matters

| Change shape | Order |
|---|---|
| **API + frontend together** | Roll API **first**, then deploy frontend. The new frontend bundle usually calls new API endpoints; reversed order means seconds-to-minutes of 404s for users hitting the new UI before the new API is live. |
| **Rules-only** | Only the `predmain-fdd-loop` image rebuild and **both job rolls** matter. API and SWA stay put. |
| **Frontend-only** | Only `npm run build:swa && swa deploy`. |
| **DB schema** | Always apply the migration **before** rolling any image that queries the new schema. |

 DB schema migrations

`stack/sql/0NN_*.sql` files auto-apply only on a **fresh** DB volume. For an existing deployment, apply via `psql` from the `ioProxyHandler` VM - the only host with a network path to the private Flex Server endpoint:

```powershell
# On your laptop (PowerShell)
scp stack/sql/0NN_<name>.sql N4EM_USER@<ioproxy-host>:~/sherlock/sql/

# Then SSH in (ZeroTier-equipped VM at 10.0.3.4)
ssh N4EM_USER@<ioproxy-host>
# Once on the VM:
#   psql -v ON_ERROR_STOP=1 "$OFDD_DB_DSN" -f ~/sherlock/sql/0NN_<name>.sql
```

Migrations are written to be idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DO ... EXCEPTION WHEN duplicate_object ...`).

 Rollback

Every successful build pushes a SHA-tagged image to ACR. Tags are immutable, so rollback is a one-liner per component:

```powershell
$PRIOR = '<prior short SHA, e.g. 6bfafa0>'

# API
az containerapp update -g Live_Services -n predmain-api `
  --image "3msecontainers.azurecr.io/predmain-api:$PRIOR" `
  --revision-suffix "rb$PRIOR"

# Both jobs (lockstep - same as forward roll)
az containerapp job update -g Live_Services -n predmain-fdd-loop `
  --image "3msecontainers.azurecr.io/predmain-fdd-loop:$PRIOR"
az containerapp job update -g Live_Services -n predmain-nightly-sync `
  --image "3msecontainers.azurecr.io/predmain-fdd-loop:$PRIOR"
```

The frontend has no built-in rollback - rebuild from the prior commit:

```powershell
git checkout <prior SHA> -- frontend
Set-Location frontend
$env:AAD_TENANT_ID = 'fce6e120-a4ac-468f-bce8-0a9efa296639'
npm run build:swa
# …then swa deploy as in step 4
```

 Quick reference: which command for which change?

| What changed | Build step | Roll step |
|---|---|---|
| API code (`openfdd_stack/platform/api/`) | `az acr build … predmain-api` | `az containerapp update predmain-api` |
| FDD driver code (`openfdd_stack/platform/drivers/`, `…/loop.py`) | `az acr build … predmain-fdd-loop` | `az containerapp job update` **× 2** |
| Rule YAML — **tuning a live rule** | n/a (no rebuild) | Edit `config/rules/*.yaml` on the `predmain-config` share (or Faults page → *Sync definitions*); picked up next FDD run |
| Rule YAML — **baked-in defaults** (`stack/rules/`, seeds a fresh share) | `az acr build … predmain-fdd-loop` **and** `predmain-api` | `az containerapp job update` **× 2** + `az containerapp update predmain-api` |
| Frontend (`frontend/src/`) | `npm run build:swa` | `swa deploy ./dist` |
| `frontend/public/staticwebapp.config.json` (routes, auth) | `npm run build:swa` (tenant injection runs every time) | `swa deploy ./dist` |
| DB schema (`stack/sql/`) | n/a | `scp` + `psql` via `ioProxyHandler` |
| Secret value (DSN, API key) | n/a | `az containerapp secret set` + `containerapp update --revision-suffix` to force restart |
| Entra App Role / user assignment | n/a | Entra portal directly; affected users must sign out + back in |

 Pulling logs

For real-time tailing of an ACA container app:

```powershell
az containerapp logs show -g Live_Services -n predmain-api --follow
```

For historical or job logs, query Log Analytics. The `log-analytics` `az` extension may fail to install on conda-bundled Python; the REST API works directly:

```powershell
$WS = az containerapp env show -g Live_Services -n cae-predmain `
  --query 'properties.appLogsConfiguration.logAnalyticsConfiguration.customerId' -o tsv

$KQL = @'
union ContainerAppConsoleLogs_CL, ContainerAppSystemLogs_CL
| where TimeGenerated > ago(2h)
| where ContainerAppName_s == 'predmain-api'        // or filter by Log_s/Reason_s for jobs
| project TimeGenerated, ContainerName_s, Reason_s=column_ifexists('Reason_s',''), Log_s
| order by TimeGenerated asc
| take 200
'@
$body = @{ query = $KQL } | ConvertTo-Json -Compress
$body | Out-File -FilePath .\.tmp_kql.json -Encoding utf8 -NoNewline
az rest --method post `
  --url "https://api.loganalytics.io/v1/workspaces/$WS/query" `
  --resource 'https://api.loganalytics.io' `
  --headers 'Content-Type=application/json' `
  --body '@.tmp_kql.json'
Remove-Item .\.tmp_kql.json
```

ACA Jobs do not populate `ContainerAppName_s` - for nightly-sync / fdd-loop logs, filter by content (`where Log_s has 'nightly-sync'`) or by the `Reason_s` system events (`SuccessfulCreate`, `PullingImage`, `ContainerTerminated`, `BackoffLimitExceeded`).

 Common pitfalls

- **`--no-logs` is essential on Windows `az acr build`.** The colorama→`cp1252` crash makes the local `az` exit `1` even when the remote build succeeded.
- **Never deploy `:latest` to ACA.** `:latest` is fine for the local docker-compose path (below), but ACA can't tell when `:latest` moves, so rollbacks become ambiguous. Always pin SHA tags.
- **Always roll both jobs in lockstep.** `predmain-fdd-loop` and `predmain-nightly-sync` share one image. Updating one and not the other has caused silent multi-week production failures.
- **Hard-refresh the browser after `swa deploy`** - SWA serves bundles with cache headers.
- **Sign out + back in (incognito) after Entra changes.** Tokens hold stale role claims for up to 1h.
- **`.dockerignore` is load-bearing.** Don't remove it.
- **Apply migrations before rolling code that depends on the new schema.** The reverse order produces 5xx until the migration lands.
- **Single-revision mode** means a bad revision becomes the only revision. Keep the prior SHA tag handy for rollback (see *Rollback* above).

---

commands to rebuild:



docker compose -f stack/docker-compose.yml restart fdd-loop


docker compose -f stack/docker-compose.yml build api
docker compose -f stack/docker-compose.yml pull db
docker compose -f stack/docker-compose.yml up -d --force-recreate db api frontend
Per-service
db (pull a fresh image, recreate container, keep the openfdd_db volume / data):


docker compose -f stack/docker-compose.yml pull db
docker compose -f stack/docker-compose.yml up -d --force-recreate db
api (rebuild image from Dockerfile.api, then recreate):


docker compose -f stack/docker-compose.yml build api
docker compose -f stack/docker-compose.yml up -d --force-recreate api
frontend (no image build - recreating runs npm run build again, picking up frontend/ changes):


docker compose -f stack/docker-compose.yml up -d --force-recreate frontend
If a frontend dependency changed (package.json / package-lock.json) and you need a clean npm ci, also wipe the cached node_modules volume first:


docker compose -f stack/docker-compose.yml rm -sf frontend
docker volume rm stack_frontend_node_modules
docker compose -f stack/docker-compose.yml up -d frontend
Volume name will be stack_frontend_node_modules if your compose project name is stack (the default when running from the stack/ folder); confirm with docker volume ls | grep frontend_node_modules first.