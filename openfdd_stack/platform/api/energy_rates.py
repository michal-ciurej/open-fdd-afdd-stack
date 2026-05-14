"""Site energy rates API — electric, gas, demand-charge per site.

One row per site (PK = site_id) seeded by migration 024. GET upserts a default
row if none exists so the endpoint never 404s; PUT is a partial upsert that
honors any subset of fields the caller sends.

Rates here replace the per-row electric_rate_per_kwh / therm_rate_usd fields
that lived inside energy_calculations.parameters. Phase 2 reads from this table
when computing opportunity costs.
"""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from openfdd_stack.platform.database import get_conn
from openfdd_stack.platform.api.auth_principal import (
    AuthUser,
    Role,
    accessible_site_ids,
    get_current_user,
    require_roles,
)
from openfdd_stack.platform.api.models import (
    SiteEnergyRatesRead,
    SiteEnergyRatesUpdate,
)

router = APIRouter(prefix="/sites", tags=["energy-rates"])
logger = logging.getLogger(__name__)

_COLS = "site_id, electric_rate_per_kwh, demand_charge_per_kw, therm_rate_usd, currency, updated_at"


def _check_site_access(site_id: UUID, user: AuthUser) -> None:
    """Raise 403 if the caller lacks permission for this site."""
    accessible = accessible_site_ids(user)
    if accessible is not None and str(site_id) not in accessible:
        raise HTTPException(403, "No permission for this site")


def _ensure_site_exists(cur, site_id: UUID) -> None:
    cur.execute("SELECT id FROM sites WHERE id = %s", (str(site_id),))
    if not cur.fetchone():
        raise HTTPException(404, "Site not found")


@router.get("/{site_id}/energy-rates", response_model=SiteEnergyRatesRead)
def get_site_energy_rates(
    site_id: UUID,
    user: AuthUser = Depends(get_current_user),
):
    """Read the rates row for a site. Inserts a default row if missing."""
    _check_site_access(site_id, user)
    with get_conn() as conn:
        with conn.cursor() as cur:
            _ensure_site_exists(cur, site_id)
            cur.execute(
                f"SELECT {_COLS} FROM site_energy_rates WHERE site_id = %s",
                (str(site_id),),
            )
            row = cur.fetchone()
            if not row:
                cur.execute(
                    f"INSERT INTO site_energy_rates (site_id) VALUES (%s) RETURNING {_COLS}",
                    (str(site_id),),
                )
                row = cur.fetchone()
                conn.commit()
    return SiteEnergyRatesRead.model_validate(dict(row))


@router.put(
    "/{site_id}/energy-rates",
    response_model=SiteEnergyRatesRead,
    dependencies=[Depends(require_roles(Role.ADMIN))],
)
def put_site_energy_rates(
    site_id: UUID,
    body: SiteEnergyRatesUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Upsert the rates row for a site. Fields omitted from the body are left unchanged."""
    _check_site_access(site_id, user)

    updates: list[str] = []
    params: list = []
    for field in (
        "electric_rate_per_kwh",
        "demand_charge_per_kw",
        "therm_rate_usd",
        "currency",
    ):
        value = getattr(body, field)
        if value is not None:
            updates.append(f"{field} = EXCLUDED.{field}")
            params.append(value)

    with get_conn() as conn:
        with conn.cursor() as cur:
            _ensure_site_exists(cur, site_id)
            if not updates:
                # No fields to change — return current state (creating default row if needed).
                cur.execute(
                    f"SELECT {_COLS} FROM site_energy_rates WHERE site_id = %s",
                    (str(site_id),),
                )
                row = cur.fetchone()
                if not row:
                    cur.execute(
                        f"INSERT INTO site_energy_rates (site_id) VALUES (%s) RETURNING {_COLS}",
                        (str(site_id),),
                    )
                    row = cur.fetchone()
                    conn.commit()
                return SiteEnergyRatesRead.model_validate(dict(row))

            insert_cols = ["site_id"] + [
                f
                for f in (
                    "electric_rate_per_kwh",
                    "demand_charge_per_kw",
                    "therm_rate_usd",
                    "currency",
                )
                if getattr(body, f) is not None
            ]
            placeholders = ", ".join(["%s"] * len(insert_cols))
            insert_params = [str(site_id)] + params
            cur.execute(
                f"""
                INSERT INTO site_energy_rates ({", ".join(insert_cols)})
                VALUES ({placeholders})
                ON CONFLICT (site_id) DO UPDATE SET
                    {", ".join(updates)},
                    updated_at = now()
                RETURNING {_COLS}
                """,
                insert_params,
            )
            row = cur.fetchone()
        conn.commit()
    logger.info("Updated energy rates for site %s", site_id)
    return SiteEnergyRatesRead.model_validate(dict(row))
