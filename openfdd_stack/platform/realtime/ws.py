"""WebSocket router: GET /ws/events with subscribe/unsubscribe and auth."""

import asyncio
import json
import logging
import secrets

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from openfdd_stack.platform.api.auth_principal import (
    Role,
    SWA_SECRET_HEADER,
    principal_from_headers,
)
from openfdd_stack.platform.config import get_platform_settings
from openfdd_stack.platform.realtime.hub import get_hub

logger = logging.getLogger(__name__)

router = APIRouter(tags=["realtime"])

_HEARTBEAT_INTERVAL = 30.0  # seconds


def _ws_auth_ok(token: str | None, headers: dict[str, str]) -> bool:
    """Validate WS auth: machine API key (token query) or SWA-injected Entra principal."""
    settings = get_platform_settings()

    # Machine path — scraper, MCP, automations.
    api_key = (getattr(settings, "api_key", None) or "").strip()
    if token and api_key and secrets.compare_digest(token.strip(), api_key):
        return True

    # Browser path — SWA forwards the Entra principal on the WS upgrade.
    ingress_secret = (getattr(settings, "swa_ingress_secret", None) or "").strip()
    if ingress_secret:
        if not secrets.compare_digest(headers.get(SWA_SECRET_HEADER, ""), ingress_secret):
            return False
    user = principal_from_headers(headers)
    if user and (user.is_machine or user.has_role(Role.ADMIN, Role.ENGINEER, Role.USER)):
        return True
    return False


@router.websocket("/ws/events")
async def websocket_events(
    websocket: WebSocket,
    token: str | None = Query(None, description="API key when OFDD_API_KEY is set"),
):
    """
    Event stream with topic subscriptions. Send JSON messages:
    - {"type":"subscribe","topics":["fault.*","crud.point.*"]}
    - {"type":"unsubscribe","topics":["crud.*"]}
    - {"type":"ping"}
    Server sends: {"type":"event",...}, {"type":"pong"}.
    """
    headers = list(websocket.scope.get("headers") or [])
    header_dict = {k.decode().lower(): v.decode() for k, v in headers}
    if not _ws_auth_ok(token, header_dict):
        await websocket.close(code=4401, reason="Unauthorized")
        return

    hub = get_hub()
    await hub.connect(websocket)
    try:
        last_heartbeat = asyncio.get_event_loop().time()
        while True:
            try:
                # Wait for either client message or heartbeat timeout
                msg = await asyncio.wait_for(
                    websocket.receive_text(), timeout=_HEARTBEAT_INTERVAL
                )
                last_heartbeat = asyncio.get_event_loop().time()
            except asyncio.TimeoutError:
                # Send heartbeat
                try:
                    await hub.send_personal(websocket, {"type": "pong"})
                except Exception:
                    break
                continue

            try:
                data = json.loads(msg)
            except json.JSONDecodeError:
                await hub.send_personal(
                    websocket,
                    {"type": "error", "message": "Invalid JSON"},
                )
                continue

            msg_type = data.get("type")
            if msg_type == "subscribe":
                topics = data.get("topics") or []
                if isinstance(topics, list):
                    await hub.subscribe(websocket, topics)
            elif msg_type == "unsubscribe":
                topics = data.get("topics") or []
                if isinstance(topics, list):
                    await hub.unsubscribe(websocket, topics)
            elif msg_type == "ping":
                await hub.send_personal(websocket, {"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(websocket)
