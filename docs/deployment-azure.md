# Azure deployment — predmain (open-fdd) on ACA + SWA + Postgres Flex Server

This document covers the deployment that took the open-fdd stack from a local
docker-compose to Azure. It is intended for the operator who already has shell
access to the resources, not as a from-scratch tutorial. The first-time setup
section is short and pointer-shaped; the **push plan** is the main day-to-day
reference for shipping changes.

## 1. Architecture

```
Browser (https://brave-sand-044267903.7.azurestaticapps.net)
   │
   │  /api/*  proxied through SWA linked-backend
   ▼
SWA (predmain-frontend, Standard SKU, West Europe)
   ├─ Entra OIDC (single-tenant)
   ├─ rolesSource → /api/auth/roles
   └─ linked backend → ACA app
                          │
                          ▼
ACA env (cae-predmain, uksouth, VNet-integrated)
   └─ aca-subnet 10.0.4.0/27
        ├─ predmain-api (Container App)            ← scheduled HTTP traffic
        │     image: 3msecontainers.azurecr.io/predmain-api:<sha>
        │     mount: openfdd-config → /app/config
        │     ingress: external 8000, auto-enabled platform auth from SWA link
        │     UDR: 172.27.0.0/16 → 10.0.3.4 (ioProxyHandler) for ZeroTier
        │
        └─ predmain-fdd-loop (Container App Job)    ← cron 0 */3 * * *
              image: 3msecontainers.azurecr.io/predmain-fdd-loop:<sha>
              mount: openfdd-config → /app/config

db-subnet 10.0.3.16/28 (delegated to Microsoft.DBforPostgreSQL)
   └─ predmain-postgres (Flex Server B2s, PG16)
        FQDN: predmain-postgres.postgres.database.azure.com
        private IP: 10.0.3.20
        database: threefdd
        TimescaleDB Apache edition only (no retention policies — see memory)

appsubnet 10.0.3.0/29
   └─ ioProxyHandler VM (10.0.3.4)
        ├─ NIC IP forwarding ON
        ├─ Linux IP forwarding + iptables FORWARD rules
        └─ ZeroTier client → on-prem networks
              (e.g. network af78… "Predictive Maintenance" → 172.27.0.0/16)

Azure Files (stpredmain27016 / predmain-config)
   └─ holds data_model.ttl, shared read-write between API and fdd-loop
```

## 2. Resource inventory (Live_Services RG, uksouth unless noted)

| Resource | Name | Notes |
|---|---|---|
| Resource group | `Live_Services` | Pre-existing, all predmain resources land here |
| VNet | `Live_Services-vnet` | Address prefixes: `10.0.1.0/24`, `10.0.3.0/27`, `10.0.4.0/27`. Peered to `3mse-Sites-vnet`. |
| Subnets (new) | `db-subnet` (10.0.3.16/28), `aca-subnet` (10.0.4.0/27) | Delegated to Postgres Flex Server and Microsoft.App respectively |
| Route table | `rt-aca-zerotier` | Attached to aca-subnet. UDRs route `172.27.0.0/16` via `10.0.3.4`. |
| Private DNS zone | `predmain-postgres.private.postgres.database.azure.com` | Linked to Live_Services-vnet only |
| Postgres Flex Server | `predmain-postgres` | B2s Burstable, PG16, 32 GiB autogrow, `timescaledb` extension allow-listed and preloaded |
| ACA env | `cae-predmain` | Workload Profiles, VNet-integrated, LAW-linked, file-share `openfdd-config` registered |
| ACA app | `predmain-api` | External ingress 8000. Image: `3msecontainers.azurecr.io/predmain-api:<sha>` |
| ACA job | `predmain-fdd-loop` | Schedule trigger, cron `0 */3 * * *`. Same image registry. |
| Storage account | `stpredmain27016` | Standard_LRS. File share `predmain-config` (5 GiB) mounted into API and Job at `/app/config` |
| Log Analytics workspace | `law-predmain` | Wires ACA env logs |
| Key Vault | `kv-predmain-27016` | RBAC-enabled. Currently underused — see "RBAC limits" section. |
| Managed identity | `mi-predmain` | Provisioned but **not** in use yet (subscription RBAC blocks role assignments). ACA app uses ACR admin auth + inline secrets. |
| Static Web App | `predmain-frontend` | Standard SKU, West Europe. Hostname `brave-sand-044267903.7.azurestaticapps.net`. Linked backend → `predmain-api`. |
| ACR | `3mseContainers` (`3msecontainers.azurecr.io`) | Pre-existing. Admin user enabled (temporary, until MI/RBAC is resolved). |
| ZT router VM | `ioProxyHandler` (10.0.3.4) | Maintenance entrypoint **and** ZeroTier router from ACA to on-prem. ZeroTier client running. |
| Entra App Registration | client ID `5a7462d1-4816-4ba1-abda-7e917941b13b` | Tenant `fce6e120-a4ac-468f-bce8-0a9efa296639`. App Roles defined: `admin`, `engineer`, `user` (lowercase values). |

## 3. First-time setup (high-level pointers)

This was done once and is captured in commit history. If recreating from scratch:

1. **Provider registrations** — `Microsoft.DBforPostgreSQL`, `Microsoft.App`, `Microsoft.KeyVault` (subscription Owner needed)
2. **Network** — extend VNet with the new prefixes; create `db-subnet` and `aca-subnet` with delegations
3. **DB** — create Flex Server with `--vnet`/`--subnet` and the auto-created private DNS zone; enable `timescaledb` extension; restart; apply [stack/sql/](../stack/sql/) migrations from ioProxyHandler over the VNet path; create the `openfdd_app` role
4. **Storage** — Storage Account → file share `predmain-config`; upload seed `data_model.ttl`
5. **ACA env** — workload-profiles env in aca-subnet, link LAW, register the file share
6. **ACR images** — build `predmain-api` and `predmain-fdd-loop` images (see push plan below for the command)
7. **ACA app + job** — create both with the image, inline secrets (DSN, API key, BACnet API key), ACR admin auth, file-share mount
8. **SWA** — create Standard SWA, configure Entra OIDC via app settings (`AAD_CLIENT_ID`, `AAD_CLIENT_SECRET`), link the ACA app as backend; build SPA bundle with `AAD_TENANT_ID` injected and deploy
9. **ZeroTier** — enable Azure NIC IP forwarding on ioProxyHandler; set Linux IP forwarding + iptables FORWARD rules; in ZT Central, add managed routes both directions; add UDR on aca-subnet for the ZT CIDR

## 4. Push plan — shipping changes to each component

> All commands assume `az login` on the Pay-As-You-Go subscription and a Git
> Bash shell on Windows. Prefix `MSYS_NO_PATHCONV=1` on any `az` command that
> takes a `/subscriptions/...` resource ID; without it Git Bash mangles the
> path. Prefix `PYTHONIOENCODING=utf-8` on `az acr build` to avoid the
> Windows `colorama` UnicodeError on streamed build logs.

### 4.1 API (`predmain-api` container app)

```bash
# 1. Build + push image (server-side build on ACR Tasks)
SHA=$(git rev-parse --short HEAD)
PYTHONIOENCODING=utf-8 az acr build -r 3mseContainers \
  -t predmain-api:$SHA -t predmain-api:latest \
  -f stack/Dockerfile.api .

# 2. Roll the ACA revision to the new image
MSYS_NO_PATHCONV=1 az containerapp update \
  -g Live_Services -n predmain-api \
  --image 3msecontainers.azurecr.io/predmain-api:$SHA \
  --revision-suffix api$SHA

# 3. Watch the new revision come up
az containerapp revision show -g Live_Services -n predmain-api \
  --revision predmain-api--api$SHA \
  --query "{p:properties.provisioningState, h:properties.healthState, r:properties.runningState}" -o json
```

ACA env is in **Single revision mode**, so the new revision automatically gets
100% traffic when it becomes Healthy and the previous one is deactivated.

If you change anything in the API's **secrets** (DSN, API key, etc.) without
changing the image, you still need a new revision so containers pick up the new
secret value at start:

```bash
az containerapp secret set -g Live_Services -n predmain-api \
  --secrets "db-dsn=$NEW_DSN"
MSYS_NO_PATHCONV=1 az containerapp update -g Live_Services -n predmain-api \
  --revision-suffix secret$(date +%H%M)
```

### 4.2 fdd-loop (`predmain-fdd-loop` container app job)

```bash
# 1. Build + push (separate image from the API)
SHA=$(git rev-parse --short HEAD)
PYTHONIOENCODING=utf-8 az acr build -r 3mseContainers \
  -t predmain-fdd-loop:$SHA -t predmain-fdd-loop:latest \
  -f stack/Dockerfile.fdd_loop .

# 2. Update the job's image
MSYS_NO_PATHCONV=1 az containerapp job update \
  -g Live_Services -n predmain-fdd-loop \
  --image 3msecontainers.azurecr.io/predmain-fdd-loop:$SHA

# 3. Manually trigger one execution to validate before the next cron fire
az containerapp job start -g Live_Services -n predmain-fdd-loop

# 4. Check the execution
az containerapp job execution list -g Live_Services --name predmain-fdd-loop \
  --query "[0].{name:name, status:properties.status, start:properties.startTime, end:properties.endTime}" -o json
```

Job execution status `Succeeded` confirms one-shot completion. Failed
executions retain logs via Log Analytics — query
`ContainerAppConsoleLogs_CL | where ContainerGroupName_s startswith 'predmain-fdd-loop'`.

### 4.3 Frontend (`predmain-frontend` SWA)

```bash
cd frontend

# 1. Build with tenant GUID + production env (.env.production sets VITE_API_BASE=/api)
AAD_TENANT_ID=fce6e120-a4ac-468f-bce8-0a9efa296639 npm run build:swa

# 2. Deploy
SWA_TOKEN=$(az staticwebapp secrets list -g Live_Services -n predmain-frontend \
  --query properties.apiKey -o tsv)
npx -y @azure/static-web-apps-cli@latest deploy ./dist \
  --deployment-token "$SWA_TOKEN" --env production
```

After deploy, **hard-refresh the browser** (Ctrl+Shift+R) or test in incognito
— SWA serves the JS bundle with cache headers, browsers reuse the old bundle
otherwise.

If you only changed `staticwebapp.config.json` (routes, auth, etc.) you still
have to run the full build:swa sequence — Vite copies `public/` files into
`dist/`, and the inject-aad-tenant script needs to run on the substituted
copy.

### 4.4 DB schema (`predmain-postgres` Flex Server)

Migrations are SQL files in [stack/sql/](../stack/sql/), numbered 001 through 023
(at time of writing). Apply new ones from ioProxyHandler (the only host with a
clear network path to the private endpoint):

```bash
# On laptop — scp the new migration up
scp stack/sql/024_*.sql N4EM_USER@<ioproxy-host>:~/sherlock/sql/

# On ioProxyHandler
cd ~/sherlock/sql
export PGHOST=predmain-postgres.postgres.database.azure.com
export PGUSER=predmain_admin
export PGDATABASE=threefdd
export PGSSLMODE=require
read -s -p "Admin password: " PGPASSWORD; export PGPASSWORD; echo

psql -v ON_ERROR_STOP=1 -f 024_*.sql
```

For data migrations (one-off seed from another DB) the pattern is
`pg_dump --data-only --column-inserts` on the source, scp to ioProxyHandler,
strip any `DISABLE TRIGGER ALL` lines that Flex Server's non-superuser admin
can't run (`sed -i '/DISABLE TRIGGER ALL/d; /ENABLE TRIGGER ALL/d' file.sql`),
then `psql --single-transaction -f file.sql`.

After bulk inserts, restart the API revision so `data_model.ttl` re-syncs from
the DB:

```bash
LATEST_REV=$(az containerapp show -g Live_Services -n predmain-api \
  --query properties.latestRevisionName -o tsv | tr -d '\r')
az containerapp revision restart -g Live_Services -n predmain-api \
  --revision "$LATEST_REV"
```

### 4.5 Entra OIDC / SWA auth config

These changes do **not** flow through any of the above pipelines. They're
controlled in the Azure / Entra portals directly:

| Change | Where |
|---|---|
| Add/remove a user's App Role assignment | Microsoft Entra ID → Enterprise applications → predmain app → Users and groups |
| Change role definitions (admin/engineer/user) | App registrations → predmain → App roles |
| Rotate client secret | App registrations → predmain → Certificates & secrets, then update `AAD_CLIENT_SECRET` in SWA app settings via `az staticwebapp appsettings set` |
| Token claims | App registrations → predmain → Token configuration |

After Entra changes, **sign out and sign in fresh in incognito** so SWA
re-invokes `rolesSource` and gets the new token claims.

### 4.6 Networking (UDRs, NSGs, peerings)

VNet/subnet/NSG changes via `az network ...` commands. Be careful with VNet
address-prefix updates — `az network vnet update --address-prefixes` is a
PUT that replaces the array; always list ALL existing prefixes plus the new
one or existing subnets get orphaned.

For new on-prem ZT networks to be reachable from ACA, add a UDR:

```bash
MSYS_NO_PATHCONV=1 az network route-table route create \
  -g Live_Services --route-table-name rt-aca-zerotier \
  -n <descriptive-name> \
  --address-prefix <ZT-CIDR> \
  --next-hop-type VirtualAppliance \
  --next-hop-ip-address 10.0.3.4
```

Then add the matching managed route in ZT Central
(`10.0.4.0/27 via <ioProxyHandler-ZT-IP-on-that-network>`) so on-prem can reply.

## 5. RBAC limits and known constraints

| Item | Status | Mitigation in current deployment |
|---|---|---|
| Subscription-scope role assignments | Operator account has Contributor at RG only, not Owner at subscription. Can't run `az role assignment create` against subscription-level scopes. | ACA app uses ACR admin user (`--registry-username 3mseContainers --registry-password`) and inline secrets instead of Managed Identity + Key Vault references. KV and MI are provisioned and ready to use when permissions allow. |
| `Microsoft.<provider>/register/action` | Operator can't register new resource providers. | Subscription Owner registered required providers once; new providers need an admin |
| TimescaleDB Community features on Flex Server | Azure ships Apache only; `add_retention_policy`, `add_compression_policy`, continuous aggregates all error at runtime | Migration 007 wraps `add_retention_policy` calls in `DO ... EXCEPTION` blocks; retention to be implemented via `pg_cron`+`drop_chunks` or in the fdd-loop Python (TODO) |
| ACA platform auth from SWA backend link | Auto-enabled when you `az staticwebapp backends link`. Blocks external curl to ACA FQDN. | Test the API only through the SWA URL path (or via internal VM in the VNet) |

## 6. Operational tips

- **Hard refresh after frontend deploys.** SWA serves the JS bundle with cache headers; old bundles persist in browser cache.
- **Incognito after Entra changes.** Tokens are minted at sign-in; existing sessions hold stale claims for up to 1h.
- **Single-revision mode is the default.** New `az containerapp update --revision-suffix X` deactivates the old revision automatically. Keep the previous SHA tag in ACR as a quick rollback option.
- **Image tags should be git SHAs.** `:latest` is fine as a convenience tag but never deploy that into ACA — Azure can't tell when `:latest` moved, so rollbacks are ambiguous.
- **Log queries.** Console/system logs are best read via `az containerapp logs show` (real-time tail) or via Log Analytics KQL when historical:
  ```kql
  ContainerAppConsoleLogs_CL
  | where ContainerAppName_s == 'predmain-api'
  | where TimeGenerated > ago(1h)
  | order by TimeGenerated desc
  ```
- **The maintenance entrypoint is `ioProxyHandler`** (10.0.3.4). It's already on ZeroTier; use it as your laptop's path into the VNet for psql / SSH / diagnostics.
- **Memory file references:** project-specific gotchas accumulated during deployment are captured in this Claude project's memory directory — see `feedback_build_substitution.md`, `project_maintenance_entrypoint.md`, `project_timescaledb_apache_only.md`, `project_swa_preserves_api_prefix.md`, `project_swa_wsfed_claim_mapping.md`. These are reminders for the operator AI; the operational implications are folded into this document.

## 7. Quick-reference: which command for which change?

| What changed | Push command (high level) |
|---|---|
| API Python code | `az acr build → predmain-api:<sha>`, then `az containerapp update --image` |
| fdd-loop driver code or rules YAML | `az acr build → predmain-fdd-loop:<sha>`, then `az containerapp job update --image` |
| Frontend React code or staticwebapp.config.json | `npm run build:swa && swa deploy` |
| Secret value (DSN, API key) | `az containerapp secret set`, then `az containerapp update --revision-suffix` to force restart |
| New DB migration (`stack/sql/0NN_*.sql`) | scp to ioProxyHandler, `psql -v ON_ERROR_STOP=1 -f` |
| Entra App Role / user assignment | Entra portal directly, then user signs out + back in (incognito) |
| New on-prem ZT subnet to reach | UDR on aca-subnet + managed route in ZT Central |
