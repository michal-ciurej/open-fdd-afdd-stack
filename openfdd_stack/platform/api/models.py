"""Pydantic models for CRUD API."""

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from openfdd_stack.platform.brick_vocabulary import normalize_or_raise


def _validate_modbus_config_common(v: Any) -> Any:
    """Shared validation for PointCreate / PointUpdate ``modbus_config``."""
    if v is None:
        return None
    if not isinstance(v, dict):
        raise ValueError("modbus_config must be a JSON object or null")
    if len(v) == 0:
        raise ValueError(
            "modbus_config cannot be an empty object; use null to clear Modbus configuration."
        )
    from openfdd_stack.platform.modbus_point_config import normalize_modbus_config

    try:
        n = normalize_modbus_config(v)
    except ValueError as e:
        # e.g. multiple registers[] — preserve the specific operator message
        raise ValueError(str(e)) from e
    if n is None:
        raise ValueError(
            "Invalid modbus_config: require non-empty host, integer address (0-65535), "
            "function holding or input; optional port 1-65535, unit_id 0-247, "
            "timeout 0.1-120 s, count 1-125; decode must be raw|uint16|int16|uint32|int32|float32 when set; "
            "float32, int32, and uint32 require count >= 2 (two 16-bit registers); "
            "scale/offset must be numeric when present. "
            "If you pasted the Modbus test-bench JSON, use the flat per-point shape (or a single-element "
            "registers list is accepted); registers[] with multiple entries belongs only in POST /bacnet/modbus_read_registers."
        )
    return n


class SiteCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    description: Optional[str] = None
    metadata_: Optional[dict] = Field(None, alias="metadata")


class SiteUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=128)
    description: Optional[str] = None
    metadata_: Optional[dict] = Field(None, alias="metadata")


class SiteRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    description: Optional[str] = None
    metadata: Optional[dict] = None
    created_at: datetime


class PointCreate(BaseModel):
    site_id: UUID
    external_id: str = Field(..., min_length=1, max_length=256)
    brick_type: Optional[str] = Field(None, max_length=128)
    fdd_input: Optional[str] = Field(None, max_length=64)
    unit: Optional[str] = Field(None, max_length=32)
    description: Optional[str] = None
    equipment_id: Optional[UUID] = None
    bacnet_device_id: Optional[str] = Field(None, max_length=64)
    object_identifier: Optional[str] = Field(None, max_length=128)
    object_name: Optional[str] = Field(None, max_length=256)
    niagara_history_path: Optional[str] = Field(
        None,
        max_length=512,
        description="Niagara history path used in BQL FROM clause, e.g. /StationName/AHU1/SupplyAirTemp. When set, the Niagara sync job will pull history for this point.",
    )
    polling: Optional[bool] = Field(
        True,
        description="If true, BACnet / Modbus scraper polls this point when applicable; set false to exclude.",
    )
    modbus_config: Optional[dict[str, Any]] = Field(
        None,
        description=(
            "Modbus TCP read spec for this point (host, port, unit_id, timeout, function, address, count; "
            "optional decode, scale, offset, label). When set, BACnet fields are usually omitted."
        ),
    )

    @field_validator("modbus_config")
    @classmethod
    def _validate_modbus_config_create(cls, v: Any) -> Any:
        return _validate_modbus_config_common(v)


class PointUpdate(BaseModel):
    brick_type: Optional[str] = Field(None, max_length=128)
    fdd_input: Optional[str] = Field(None, max_length=64)
    unit: Optional[str] = Field(None, max_length=32)
    description: Optional[str] = None
    equipment_id: Optional[UUID] = None
    bacnet_device_id: Optional[str] = Field(None, max_length=64)
    object_identifier: Optional[str] = Field(None, max_length=128)
    object_name: Optional[str] = Field(None, max_length=256)
    niagara_history_path: Optional[str] = Field(None, max_length=512)
    polling: Optional[bool] = None
    modbus_config: Optional[dict[str, Any]] = None

    @field_validator("modbus_config")
    @classmethod
    def _validate_modbus_config_update(cls, v: Any) -> Any:
        return _validate_modbus_config_common(v)


class PointRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    site_id: UUID
    external_id: str
    brick_type: Optional[str] = None
    fdd_input: Optional[str] = None
    unit: Optional[str] = None
    description: Optional[str] = None
    equipment_id: Optional[UUID] = None
    bacnet_device_id: Optional[str] = None
    object_identifier: Optional[str] = None
    object_name: Optional[str] = None
    niagara_history_path: Optional[str] = None
    polling: bool = True
    modbus_config: Optional[dict[str, Any]] = None
    created_at: datetime


def _validate_equipment_type_field(v: Any) -> Any:
    """Normalize and validate ``equipment_type`` against the Brick 1.4 allowlist.

    Aliases (FCU, brick:Cooling-Tower, "Fan Coil Unit", …) are silently rewritten
    so older clients keep working. Anything not in the allowlist after
    normalization raises a 422 listing the accepted values — the message is
    consumed by the LLM in the AI-assisted tagging workflow when it sends an
    unrecognized class.
    """
    return normalize_or_raise(v)


class EquipmentCreate(BaseModel):
    site_id: UUID
    name: str = Field(..., min_length=1, max_length=128)
    description: Optional[str] = None
    equipment_type: Optional[str] = Field(
        None,
        description=(
            "Brick 1.4 equipment class (long-form, e.g. ``Fan_Coil_Unit``, ``Chiller``). "
            "Aliases are normalized: ``FCU`` → ``Fan_Coil_Unit``, ``brick:Cooling-Tower`` → "
            "``Cooling_Tower``, etc. See GET /data-model/vocabulary."
        ),
    )
    metadata_: Optional[dict] = Field(None, alias="metadata")
    feeds_equipment_id: Optional[UUID] = Field(
        None, description="Brick: this equipment feeds that one."
    )
    fed_by_equipment_id: Optional[UUID] = Field(
        None, description="Brick: this equipment is fed by that one."
    )

    @field_validator("equipment_type")
    @classmethod
    def _validate_equipment_type(cls, v: Any) -> Any:
        return _validate_equipment_type_field(v)


class EquipmentUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=128)
    description: Optional[str] = None
    equipment_type: Optional[str] = Field(
        None,
        description=(
            "Brick 1.4 equipment class (long-form). Aliases are normalized; see "
            "GET /data-model/vocabulary for the canonical list."
        ),
    )
    metadata_: Optional[dict] = Field(None, alias="metadata")
    feeds_equipment_id: Optional[UUID] = None
    fed_by_equipment_id: Optional[UUID] = None

    @field_validator("equipment_type")
    @classmethod
    def _validate_equipment_type(cls, v: Any) -> Any:
        return _validate_equipment_type_field(v)


class EquipmentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    site_id: UUID
    name: str
    description: Optional[str] = None
    equipment_type: Optional[str] = None
    metadata: Optional[dict] = None
    feeds_equipment_id: Optional[UUID] = None
    fed_by_equipment_id: Optional[UUID] = None
    created_at: datetime


class SiteEnergyRatesRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    site_id: UUID
    electric_rate_per_kwh: float
    demand_charge_per_kw: float
    therm_rate_usd: float
    currency: str
    updated_at: datetime


class SiteEnergyRatesUpdate(BaseModel):
    electric_rate_per_kwh: Optional[float] = Field(None, ge=0)
    demand_charge_per_kw: Optional[float] = Field(None, ge=0)
    therm_rate_usd: Optional[float] = Field(None, ge=0)
    currency: Optional[str] = Field(None, min_length=1, max_length=8)


class EquipmentEnergyProfileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    equipment_id: UUID
    nameplate_kw: Optional[float] = None
    motor_hp: Optional[float] = None
    motor_efficiency: Optional[float] = None
    design_cfm: Optional[float] = None
    design_sat_f: Optional[float] = None
    design_static_pressure_inwc: Optional[float] = None
    design_cop: Optional[float] = None
    design_heating_efficiency: Optional[float] = None
    occupied_hours_per_year: Optional[float] = None
    updated_at: datetime


class EquipmentEnergyProfileUpdate(BaseModel):
    """All fields optional; PUT is treated as a partial upsert. NULL clears a value."""

    nameplate_kw: Optional[float] = Field(None, ge=0)
    motor_hp: Optional[float] = Field(None, ge=0)
    motor_efficiency: Optional[float] = Field(None, gt=0, le=1)
    design_cfm: Optional[float] = Field(None, ge=0)
    design_sat_f: Optional[float] = None
    design_static_pressure_inwc: Optional[float] = Field(None, ge=0)
    design_cop: Optional[float] = Field(None, gt=0)
    design_heating_efficiency: Optional[float] = Field(None, gt=0, le=1)
    occupied_hours_per_year: Optional[float] = Field(None, ge=0, le=8784)


MEASURE_FAMILIES = ("runtime", "setpoint_reset", "airside_thermal", "degradation")
DATA_QUALITIES = ("observed", "partial", "assumed")


class EnergyOpportunityResultRead(BaseModel):
    """Cached computed result block. All numeric fields nullable so a row with
    missing inputs still serialises cleanly."""

    model_config = ConfigDict(from_attributes=True)

    baseline_annual_cost_usd: Optional[float] = None
    projected_annual_cost_usd: Optional[float] = None
    annual_savings_usd: Optional[float] = None
    annual_kwh_saved: Optional[float] = None
    annual_therms_saved: Optional[float] = None
    peak_kw_reduced: Optional[float] = None
    simple_payback_years: Optional[float] = None
    npv_5yr_usd: Optional[float] = None
    fault_hours_observed: Optional[float] = None
    data_quality: str = "assumed"
    missing_inputs: list[str] = Field(default_factory=list)
    notes: Optional[str] = None
    computed_at: Optional[datetime] = None


class EnergyOpportunityRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    equipment_id: UUID
    external_id: str
    name: str
    description: Optional[str] = None
    measure_family: str
    calc_type: str
    fdd_rule_id: Optional[str] = None
    delta_params: dict[str, Any]
    capex_usd: float
    enabled: bool
    created_at: datetime
    updated_at: datetime
    result: Optional[EnergyOpportunityResultRead] = None


class EnergyOpportunityCreate(BaseModel):
    equipment_id: UUID
    external_id: str = Field(..., min_length=1, max_length=256)
    name: str = Field(..., min_length=1, max_length=256)
    description: Optional[str] = None
    measure_family: str
    calc_type: str = Field(..., min_length=1, max_length=64)
    fdd_rule_id: Optional[str] = Field(None, max_length=128)
    delta_params: dict[str, Any] = Field(default_factory=dict)
    capex_usd: float = Field(0.0, ge=0)
    enabled: bool = True

    @field_validator("measure_family")
    @classmethod
    def _check_measure_family(cls, v: str) -> str:
        if v not in MEASURE_FAMILIES:
            raise ValueError(
                f"measure_family must be one of {MEASURE_FAMILIES}, got {v!r}"
            )
        return v


class EnergyOpportunityUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=256)
    description: Optional[str] = None
    measure_family: Optional[str] = None
    calc_type: Optional[str] = Field(None, min_length=1, max_length=64)
    fdd_rule_id: Optional[str] = Field(None, max_length=128)
    delta_params: Optional[dict[str, Any]] = None
    capex_usd: Optional[float] = Field(None, ge=0)
    enabled: Optional[bool] = None

    @field_validator("measure_family")
    @classmethod
    def _check_measure_family(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        if v not in MEASURE_FAMILIES:
            raise ValueError(
                f"measure_family must be one of {MEASURE_FAMILIES}, got {v!r}"
            )
        return v


class EnergyOpportunityPreviewBody(BaseModel):
    """Preview a not-yet-saved opportunity. Used by the AddMeasureDialog wizard."""

    equipment_id: UUID
    calc_type: str = Field(..., min_length=1, max_length=64)
    delta_params: dict[str, Any] = Field(default_factory=dict)
    capex_usd: float = Field(0.0, ge=0)
