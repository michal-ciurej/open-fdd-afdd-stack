#!/usr/bin/env bash
set -euo pipefail

HOST=""
MODE="auto"
INSECURE_TLS=1

usage() {
  cat <<'EOF'
Usage:
  probe_openfdd_lan.sh --host <ip-or-hostname> [--mode auto|http|tls] [--strict-tls]

Examples:
  ./openclaw/scripts/probe_openfdd_lan.sh --host 192.168.1.50
  ./openclaw/scripts/probe_openfdd_lan.sh --host demo.local --mode tls
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      HOST="$2"; shift 2 ;;
    --mode)
      MODE="$2"; shift 2 ;;
    --strict-tls)
      INSECURE_TLS=0; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 1 ;;
  esac
done

if [[ -z "$HOST" ]]; then
  usage
  exit 1
fi

curl_code() {
  local url="$1"
  local insecure="${2:-0}"
  if [[ "$insecure" == "1" ]]; then
    curl -k -sS -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo 000
  else
    curl -sS -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo 000
  fi
}

note_for() {
  case "$1" in
    200) echo "reachable" ;;
    301|302) echo "redirect" ;;
    401) echo "auth-gated but alive" ;;
    403) echo "forbidden but alive" ;;
    404) echo "service up, path missing" ;;
    502) echo "proxy/upstream failure" ;;
    000) echo "connect or TLS failure" ;;
    *) echo "inspect manually if important" ;;
  esac
}

print_row() {
  local label="$1"
  local url="$2"
  local code="$3"
  printf '| %s | `%s` | %s | %s |\n' "$label" "$url" "$code" "$(note_for "$code")"
}

http_root="http://${HOST}/"
http_api_health="http://${HOST}:8000/health"
http_api_docs="http://${HOST}:8000/docs"
http_bacnet_docs="http://${HOST}:8080/docs"
http_frontend_raw="http://${HOST}:5173/"
http_caddy_alt="http://${HOST}:8880/"
https_root="https://${HOST}/"
https_api_health="https://${HOST}/api/health"

echo "# Open-FDD LAN probe"
echo
echo "- Host: ${HOST}"
echo "- Mode hint: ${MODE}"
echo
printf '| Check | URL | Code | Note |\n'
printf '|---|---|---:|---|\n'

print_row "HTTP root" "$http_root" "$(curl_code "$http_root")"
print_row "HTTP API health" "$http_api_health" "$(curl_code "$http_api_health")"
print_row "HTTP API docs" "$http_api_docs" "$(curl_code "$http_api_docs")"
print_row "HTTP BACnet docs" "$http_bacnet_docs" "$(curl_code "$http_bacnet_docs")"
print_row "HTTP raw frontend" "$http_frontend_raw" "$(curl_code "$http_frontend_raw")"
print_row "HTTP alternate Caddy" "$http_caddy_alt" "$(curl_code "$http_caddy_alt")"
print_row "HTTPS root" "$https_root" "$(curl_code "$https_root" "$INSECURE_TLS")"
print_row "HTTPS API via Caddy" "$https_api_health" "$(curl_code "$https_api_health" "$INSECURE_TLS")"

echo
echo "Interpretation hints:"
echo "- HTTP mode often means HTTP root = 200 and direct :8000/health = 200."
echo "- TLS mode often means HTTPS root = 200, HTTPS /api/health = 200, HTTP root = 301/302, and direct :8000 may fail from the client."
echo "- 401/403 on docs usually means auth-gated, not necessarily down."
