"""Equipment energy profile API — typed engineering/sizing values per equipment.

One row per equipment (PK = equipment_id) seeded sparsely by migration 025.
GET upserts a default (all-NULL) row if none exists so the endpoint never 404s;
PUT is a partial upsert — fields omitted from the body are left unchanged.

This data drives the energy opportunity cost calculator in phase 2: the resolver
reads design CFM, motor HP, COP, etc. from here rather than from the per-calc
parameters blob.

Both admin and engineer roles may edit profiles; configuring equipment metadata
to enable per-equipment opportunity analysis is part of the engineer workflow.
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
    EquipmentEnergyProfileRead,
    EquipmentEnergyProfileUpdate,
)

router = APIRouter(prefix="/equipment", tags=["equipment-energy-profile"])
logger = logging.getLogger(__name__)

_PROFILE_FIELDS = (
    "nameplate_kw",
    "motor_hp",
    "motor_efficiency",
    "design_cfm",
    "design_sat_f",
    "design_static_pressure_inwc",
    "design_cop",
    "design_heating_efficiency",
    "occupied_hours_per_year",
)
_COLS = "equipment_id, " + ", ".join(_PROFILE_FIELDS) + ", updated_at"


def _lookup_equipment_site(cur, equipment_id: UUID) -> str:
    """Return the equipment's site_id (as text), or raise 404."""
    cur.execute(
        "SELECT site_id FROM equipment WHERE id = %s",
        (str(equipment_id),),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Equipment not found")
    return str(row["site_id"])


def _check_equipment_access(cur, equipment_id: UUID, user: AuthUser) -> None:
    site_id = _lookup_equipment_site(cur, equipment_id)
    accessible = accessible_site_ids(user)
    if accessible is not None and site_id not in accessible:
        raise HTTPException(403, "No permission for this equipment")


@router.get(
    "/{equipment_id}/energy-profile",
    response_model=EquipmentEnergyProfileRead,
)
def get_equipment_energy_profile(
    equipment_id: UUID,
    user: AuthUser = Depends(get_current_user),
):
    """Read the energy profile row for a piece of equipment. Creates a default
    (all-NULL) row if missing so the UI can render an empty form."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            _check_equipment_access(cur, equipment_id, user)
            cur.execute(
                f"SELECT {_COLS} FROM equipment_energy_profile WHERE equipment_id = %s",
                (str(equipment_id),),
            )
            row = cur.fetchone()
            if not row:
                cur.execute(
                    f"INSERT INTO equipment_energy_profile (equipment_id) VALUES (%s) RETURNING {_COLS}",
                    (str(equipment_id),),
                )
                row = cur.fetchone()
                conn.commit()
    return EquipmentEnergyProfileRead.model_validate(dict(row))


@router.put(
    "/{equipment_id}/energy-profile",
    response_model=EquipmentEnergyProfileRead,
    dependencies=[Depends(require_roles(Role.ADMIN, Role.ENGINEER))],
)
def put_equipment_energy_profile(
    equipment_id: UUID,
    body: EquipmentEnergyProfileUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Upsert the energy profile row for a piece of equipment. Fields omitted
    from the body are left unchanged; explicit null clears a value."""
    body_dict = body.model_dump(exclude_unset=True)

    with get_conn() as conn:
        with conn.cursor() as cur:
            _check_equipment_access(cur, equipment_id, user)

            if not body_dict:
                # No-op PUT — return current state, creating default if needed.
                cur.execute(
                    f"SELECT {_COLS} FROM equipment_energy_profile WHERE equipment_id = %s",
                    (str(equipment_id),),
                )
                row = cur.fetchone()
                if not row:
                    cur.execute(
                        f"INSERT INTO equipment_energy_profile (equipment_id) VALUES (%s) RETURNING {_COLS}",
                        (str(equipment_id),),
                    )
                    row = cur.fetchone()
                    conn.commit()
                return EquipmentEnergyProfileRead.model_validate(dict(row))

            insert_cols = ["equipment_id"] + list(body_dict.keys())
            insert_params = [str(equipment_id)] + list(body_dict.values())
            placeholders = ", ".join(["%s"] * len(insert_cols))
            set_clauses = ", ".join(
                f"{field} = EXCLUDED.{field}" for field in body_dict.keys()
            )
            cur.execute(
                f"""
                INSERT INTO equipment_energy_profile ({", ".join(insert_cols)})
                VALUES ({placeholders})
                ON CONFLICT (equipment_id) DO UPDATE SET
                    {set_clauses},
                    updated_at = now()
                RETURNING {_COLS}
                """,
                insert_params,
            )
            row = cur.fetchone()
        conn.commit()
    logger.info("Updated energy profile for equipment %s", equipment_id)
    return EquipmentEnergyProfileRead.model_validate(dict(row))
