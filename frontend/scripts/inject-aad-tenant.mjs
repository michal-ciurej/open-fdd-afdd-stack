/**
 * Post-build substitution: writes the Entra tenant GUID into the deployed
 * staticwebapp.config.json. Source file keeps the placeholder so the repo
 * stays tenant-agnostic.
 *
 * Required env: AAD_TENANT_ID (GUID).
 * Run via: npm run build:swa
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PLACEHOLDER = "AAD_TENANT_ID";
const TARGET = resolve("dist/staticwebapp.config.json");
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(msg) {
  console.error(`[inject-aad-tenant] ERROR: ${msg}`);
  process.exit(1);
}

const tenantId = process.env.AAD_TENANT_ID?.trim();
if (!tenantId) {
  fail("AAD_TENANT_ID is not set. Export it before running: export AAD_TENANT_ID=<your-tenant-guid>");
}
if (!GUID.test(tenantId)) {
  fail(`AAD_TENANT_ID is not a valid GUID: '${tenantId}'`);
}
if (!existsSync(TARGET)) {
  fail(`${TARGET} not found. Run 'npm run build' first so Vite copies public/staticwebapp.config.json into dist/.`);
}

let body = readFileSync(TARGET, "utf8");
if (!body.includes(PLACEHOLDER)) {
  fail(`${TARGET} does not contain the '${PLACEHOLDER}' placeholder — was the source already substituted, or did the build copy a different file?`);
}
body = body.split(PLACEHOLDER).join(tenantId);

// Sanity-check the substituted JSON before writing.
let parsed;
try {
  parsed = JSON.parse(body);
} catch (err) {
  fail(`substituted output is not valid JSON: ${err.message}`);
}
const issuer = parsed?.auth?.identityProviders?.azureActiveDirectory?.registration?.openIdIssuer;
if (typeof issuer !== "string" || !issuer.includes(tenantId)) {
  fail(`expected openIdIssuer to contain the tenant GUID, got: ${issuer}`);
}

writeFileSync(TARGET, body);
console.log(`[inject-aad-tenant] wrote tenant ${tenantId} into ${TARGET}`);
