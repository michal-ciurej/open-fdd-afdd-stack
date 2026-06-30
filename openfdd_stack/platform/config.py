"""Platform configuration.

Runtime config can come from env (OFDD_*) or from the RDF graph (PUT /config).
When the graph has config, it overrides env for those keys. Overlay is populated
on API startup from data_model.ttl and on PUT /config.
"""

from typing import Optional

from pydantic import AliasChoices, Field

try:
    from pydantic_settings import BaseSettings
except ImportError:
    from pydantic import BaseSettings  # type: ignore

# Overlay from RDF graph (GET/PUT /config). Merged over env in get_platform_settings().
_config_overlay: dict = {}


def set_config_overlay(overlay: dict | None) -> None:
    """Set the config overlay (from graph). Called after load_from_file() and on PUT /config."""
    global _config_overlay
    _config_overlay = dict(overlay) if overlay else {}


def get_config_overlay() -> dict:
    """Return current overlay (snake_case keys)."""
    return dict(_config_overlay)


class PlatformSettings(BaseSettings):
    """App settings from env."""

    db_dsn: str = "postgresql://postgres:postgres@localhost:5432/openfdd"
    brick_ttl_dir: str = "data/brick"
    brick_ttl_path: str = (
        "config/data_model.ttl"  # unified graph: Brick + BACnet + config; auto-synced on CRUD
    )
    app_title: str = "ThreeFDD API"
    app_version: str = "2.0.5"
    debug: bool = False

    # FDD loop
    rule_interval_hours: float = 3.0  # fractional OK for testing (e.g. 0.1 = 6 min)
    lookback_days: int = 3
    fdd_trigger_file: Optional[str] = (
        "config/.run_fdd_now"  # touch to run now + reset timer
    )
    rules_dir: str = (
        "stack/rules"  # default rules next to stack/docker; hot reload each run
    )
    # When True: FDD loop fails fast on bad column_map / non-numeric inputs (open-fdd input_validation=strict, skip_missing_columns=False). Use in dev/CI.
    fdd_strict_rules: bool = False

    # Manual FDD trigger on Azure (POST /run-fdd). When fdd_job_resource_id is set,
    # /run-fdd starts ONE execution of this ACA Job (the dedicated, correctly-sized
    # predmain-fdd-loop) via its managed identity, instead of touching the local
    # trigger file. Running FDD in-process in the API container OOM-kills it; the job
    # is the right home. fdd_job_mi_client_id selects the user-assigned identity
    # (mi-predmain) on the token request. Leave unset for local docker-compose, where
    # the run_rule_loop --loop poller consumes the trigger file instead.
    fdd_job_resource_id: Optional[str] = None  # ARM id: /subscriptions/.../Microsoft.App/jobs/predmain-fdd-loop
    fdd_job_mi_client_id: Optional[str] = None  # clientId of the user-assigned MI (mi-predmain)
    fdd_job_api_version: str = "2024-03-01"

    # Driver intervals
    bacnet_scrape_interval_min: int = 5
    open_meteo_interval_hours: int = 24

    # Driver on/off (like Volttron agent enable/disable)
    bacnet_scrape_enabled: bool = True
    open_meteo_enabled: bool = True

    # Open-Meteo: geo and fetch window (used when open_meteo_enabled)
    open_meteo_latitude: float = 41.88
    open_meteo_longitude: float = -87.63
    open_meteo_timezone: str = "America/Chicago"
    open_meteo_days_back: int = 3
    open_meteo_site_id: str = "default"  # site name or UUID to store weather under

    # Graph model: sync in-memory graph to data_model.ttl every N minutes
    graph_sync_interval_min: int = 5

    # BACnet: use diy-bacnet-server JSON-RPC when set (e.g. http://localhost:8080)
    bacnet_server_url: Optional[str] = None
    # Site to tag when scraping (single gateway or remote gateway pushing to central)
    bacnet_site_id: str = "default"
    # Optional: multiple gateways (central aggregator). JSON array of {"url", "site_id", ...}; scrape uses KG points per site.
    bacnet_gateways: Optional[str] = None

    # API key for REST/WebSocket auth (Bearer). Used by machine integrations (BACnet scraper, MCP) - separate from browser SSO.
    api_key: Optional[str] = None
    # When true, expose /docs, /redoc, /openapi.json (HTTP lab). False in cloud / production.
    enable_openapi_docs: bool = False
    # When true, treat X-Forwarded-Proto: https as HTTPS for Secure cookies (TLS at reverse proxy / ACA ingress).
    trust_forwarded_proto: bool = False
    # Optional shared secret enforced by EntraPrincipalMiddleware on top of the ACA IP allowlist.
    # Leave unset when ACA ingress is locked down to SWA outbound IPs (recommended).
    swa_ingress_secret: Optional[str] = None

    # Reserved for RDF overlay compatibility ("disabled" in core builds;
    # reports "anthropic" via /capabilities when anthropic_api_key is set).
    ai_backend: str = "disabled"

    # AI-assisted Brick tagging (Anthropic). The entire flow lives in
    # openfdd_stack/platform/ai/tagging.py. Key is read from env / Key Vault and
    # never sent to the browser. When unset, POST /data-model/ai-tag returns 503.
    # Read from the Anthropic SDK's standard ANTHROPIC_API_KEY (so the bare name
    # works locally and the SDK convention is honored), falling back to the
    # OFDD_-prefixed name. validation_alias bypasses env_prefix for this field.
    anthropic_api_key: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("ANTHROPIC_API_KEY", "OFDD_ANTHROPIC_API_KEY"),
    )
    ai_tag_model: str = "claude-sonnet-4-6"  # Opus 4.8 ("claude-opus-4-8") for hard sites
    # Output budget per chunk. Each point echoes its identity fields back, so the
    # tool-call JSON is large; too small a budget truncates it (no 'points' array).
    ai_tag_max_tokens: int = 20000
    ai_tag_chunk_size: int = 20  # points per Anthropic call; grouped by BACnet device
    ai_tag_max_retries: int = 2  # prompt-chained validation retries per chunk
    ai_tag_concurrency: int = 5  # chunks tagged in parallel (background run)

    model_config = {"env_prefix": "OFDD_", "env_file": ".env"}


def get_platform_settings() -> PlatformSettings:
    """Effective settings: env first, then overlay from RDF (PUT /config). Not cached so overlay is visible.
    Overlay uses API keys (e.g. bacnet_enabled); we map to settings attrs (e.g. bacnet_scrape_enabled).
    """
    s = PlatformSettings()
    overlay = get_config_overlay()
    key_to_attr = {
        "bacnet_enabled": "bacnet_scrape_enabled",
        "ai_backend": "ai_backend",
    }  # RDF/API name -> PlatformSettings attr
    for k, v in overlay.items():
        attr = key_to_attr.get(k, k)
        if hasattr(s, attr):
            setattr(s, attr, v)
    return s
