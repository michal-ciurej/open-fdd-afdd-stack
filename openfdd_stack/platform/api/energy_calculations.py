"""CRUD for FDD energy / savings calculation specs (DB + TTL knowledge graph)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID

import psycopg2
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from psycopg2.extras import Json

from openfdd_stack.platform.data_model_ttl import sync_ttl_to_file
from openfdd_stack.platform.database import get_conn
from openfdd_stack.platform.energy_calc_library import (
    ALLOWED_CALC_TYPES,
    list_calc_types_public,
    preview_energy_calc,
)
from openfdd_stack.platform.realtime import TOPIC_CRUD_ENERGY_CALC, emit

router = APIRouter(prefix="/energy-calculations", tags=["energy-calculations"])


class EnergyCalculationCreate(BaseModel):
    site_id: UUID
    equipment_id: Optional[UUID] = None
    external_id: str = Field(..., min_length=1, max_length=256)
    name: str = Field(..., min_length=1, max_length=256)
    description: Optional[str] = None
    calc_type: str = Field(..., min_length=1, max_length=64)
    parameters: dict[str, Any] = Field(default_factory=dict)
    point_bindings: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True


class EnergyCalculationUpdate(BaseModel):
    equipment_id: Optional[UUID] = None
    name: Optional[str] = Field(None, min_length=1, max_length=256)
    description: Optional[str] = None
    calc_type: Optional[str] = Field(None, min_length=1, max_length=64)
    parameters: Optional[dict[str, Any]] = None
    point_bindings: Optional[dict[str, Any]] = None
    enabled: Optional[bool] = None


class EnergyCalculationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    site_id: UUID
    equipment_id: Optional[UUID] = None
    external_id: str
    name: str
    description: Optional[str] = None
    calc_type: str
    parameters: dict[str, Any]
    point_bindings: dict[str, Any]
    enabled: bool
    created_at: datetime
    updated_at: datetime


class PreviewBody(BaseModel):
    calc_type: str
    parameters: dict[str, Any] = Field(default_factory=dict)


def _validate_calc_type(ct: str) -> None:
    if ct not in ALLOWED_CALC_TYPES:
        raise HTTPException(
            400,
            f"Unknown calc_type {ct!r}. Use GET /energy-calculations/calc-types.",
        )


_COLS = (
    "id, site_id, equipment_id, external_id, name, description, calc_type, "
    "parameters, point_bindings, enabled, created_at, updated_at"
)


@router.get("/calc-types")
def get_calc_types():
    """Field metadata for Energy Engineering UI dropdowns."""
    return {"calc_types": list_calc_types_public()}


@router.post("/preview")
def post_preview(body: PreviewBody):
    """Run the calculation library with draft parameters (no DB write)."""
    _validate_calc_type(body.calc_type)
    return preview_energy_calc(body.calc_type, body.parameters)


@router.get("", response_model=list[EnergyCalculationRead])
def list_energy_calculations(
    site_id: UUID | None = None,
    equipment_id: UUID | None = None,
    limit: int = Query(500, ge=1, le=2000),
    offset: int = Query(0, ge=0),
):
    with get_conn() as conn:
        with conn.cursor() as cur:
            if equipment_id:
                cur.execute(
                    f"""SELECT {_COLS} FROM energy_calculations
                        WHERE equipment_id = %s ORDER BY external_id LIMIT %s OFFSET %s""",
                    (str(equipment_id), limit, offset),
                )
            elif site_id:
                cur.execute(
                    f"""SELECT {_COLS} FROM energy_calculations
                        WHERE site_id = %s ORDER BY external_id LIMIT %s OFFSET %s""",
                    (str(site_id), limit, offset),
                )
            else:
                cur.execute(
                    f"""SELECT {_COLS} FROM energy_calculations
                        ORDER BY site_id, external_id LIMIT %s OFFSET %s""",
                    (limit, offset),
                )
            rows = cur.fetchall()
    return [EnergyCalculationRead.model_validate(dict(r)) for r in rows]


@router.post("", response_model=EnergyCalculationRead)
def create_energy_calculation(body: EnergyCalculationCreate):
    _validate_calc_type(body.calc_type)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""SELECT {_COLS} FROM energy_calculations
                    WHERE site_id = %s AND external_id = %s""",
                (str(body.site_id), body.external_id),
            )
            existing = cur.fetchone()
            if existing:
                return EnergyCalculationRead.model_validate(dict(existing))
            try:
                cur.execute(
                    f"""INSERT INTO energy_calculations
                        (site_id, equipment_id, external_id, name, description, calc_type,
                         parameters, point_bindings, enabled, updated_at)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                        RETURNING {_COLS}""",
                    (
                        str(body.site_id),
                        str(body.equipment_id) if body.equipment_id else None,
                        body.external_id,
                        body.name,
                        body.description,
                        body.calc_type,
                        Json(body.parameters or {}),
                        Json(body.point_bindings or {}),
                        body.enabled,
                        datetime.now(timezone.utc),
                    ),
                )
                row = cur.fetchone()
            except psycopg2.IntegrityError:
                conn.rollback()
                raise HTTPException(
                    409, "Energy calculation with this external_id already exists for this site"
                )
        conn.commit()
    try:
        sync_ttl_to_file()
    except Exception:
        pass
    emit(
        TOPIC_CRUD_ENERGY_CALC + ".created",
        {"id": str(row["id"]), "site_id": str(row["site_id"]), "external_id": row["external_id"]},
    )
    return EnergyCalculationRead.model_validate(dict(row))


@router.get("/{ec_id}", response_model=EnergyCalculationRead)
def get_energy_calculation(ec_id: UUID):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(f"""SELECT {_COLS} FROM energy_calculations WHERE id = %s""", (str(ec_id),))
            row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Energy calculation not found")
    return EnergyCalculationRead.model_validate(dict(row))


@router.patch("/{ec_id}", response_model=EnergyCalculationRead)
def update_energy_calculation(ec_id: UUID, body: EnergyCalculationUpdate):
    data = body.model_dump(exclude_unset=True)
    if "calc_type" in data and data["calc_type"] is not None:
        _validate_calc_type(data["calc_type"])
    updates, params = [], []
    if "equipment_id" in data:
        updates.append("equipment_id = %s")
        params.append(str(data["equipment_id"]) if data["equipment_id"] else None)
    if "name" in data:
        updates.append("name = %s")
        params.append(data["name"])
    if "description" in data:
        updates.append("description = %s")
        params.append(data["description"])
    if "calc_type" in data:
        updates.append("calc_type = %s")
        params.append(data["calc_type"])
    if "parameters" in data:
        updates.append("parameters = %s")
        params.append(Json(data["parameters"] if data["parameters"] is not None else {}))
    if "point_bindings" in data:
        updates.append("point_bindings = %s")
        params.append(Json(data["point_bindings"] if data["point_bindings"] is not None else {}))
    if "enabled" in data:
        updates.append("enabled = %s")
        params.append(data["enabled"])
    if not updates:
        return get_energy_calculation(ec_id)
    updates.append("updated_at = %s")
    params.append(datetime.now(timezone.utc))
    params.append(str(ec_id))
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""UPDATE energy_calculations SET {", ".join(updates)} WHERE id = %s
                    RETURNING {_COLS}""",
                params,
            )
            row = cur.fetchone()
        conn.commit()
    if not row:
        raise HTTPException(404, "Energy calculation not found")
    try:
        sync_ttl_to_file()
    except Exception:
        pass
    emit(TOPIC_CRUD_ENERGY_CALC + ".updated", {"id": str(ec_id)})
    return EnergyCalculationRead.model_validate(dict(row))


@router.delete("/{ec_id}")
def delete_energy_calculation(ec_id: UUID):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM energy_calculations WHERE id = %s RETURNING id", (str(ec_id),)
            )
            if not cur.fetchone():
                raise HTTPException(404, "Energy calculation not found")
        conn.commit()
    try:
        sync_ttl_to_file()
    except Exception:
        pass
    emit(TOPIC_CRUD_ENERGY_CALC + ".deleted", {"id": str(ec_id)})
    return {"status": "deleted"}
