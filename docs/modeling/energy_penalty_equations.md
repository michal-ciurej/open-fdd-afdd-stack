---
title: Default FDD energy penalty catalog
parent: Data modeling
nav_order: 9
---

# Default FDD energy penalty equations (platform catalog)

The stack ships **18 engineering narratives** for common HVAC faults, ordered from **easiest** (schedules, booleans, simple setpoint math) to **hardest** (enthalpy, plant COP, network rollups). They are **not** automatic trend integrations: each row is an **`EnergyCalculation`** with a **`calc_type`** from `openfdd_stack.platform.energy_calc_library`, **static parameters** for M&V-style preview, and optional **`point_bindings`** (semantic key → point `external_id`) for documentation and future analytics.

## Where things live (single sources of truth)

| Concern | Location |
|--------|-----------|
| **Predefined calculators** (`calc_type`, fields, preview math) | Python: `openfdd_stack/platform/energy_calc_library.py` |
| **18 default narratives + default parameters** | Python: `openfdd_stack/platform/energy_penalty_catalog.py` |
| **Per-site enabled/disabled rows, equipment link** | Postgres `energy_calculations`; UI: **Energy Engineering** → tree (same enable/disable/delete pattern as the points tree) |
| **Knowledge graph / SPARQL** | `config/data_model.ttl`: `ofdd:EnergyCalculation` (+ optional `ofdd:penaltyCatalogSeq` when `_penalty_catalog_seq` is in parameters) |
| **Weather (Open-Meteo)** | `ofdd:platform_config` / site - **one** Open-Meteo config per deployment (see [Configuration](../configuration)) |
| **Utility £/kWh, $/therm** | Enter in **calc parameters** (defaults in seed rows) or centralize via site/platform config over time; export bundle carries whatever you saved |

## Seeding the 18 defaults

- **UI:** Energy Engineering → **AI-assisted energy calculations** → **Seed default penalty catalog (18)**. Rows are inserted **disabled** (`enabled: false`) with `external_id` `penalty_default_01` … `penalty_default_18`.
- **API:** `POST /energy-calculations/seed-default-penalty-catalog?site_id=<uuid>&replace=false`  
  - `replace=true`: delete existing `penalty_default_*` for the site, then insert all 18.
- **Read-only catalog (no DB):** `GET /energy-calculations/penalty-catalog`
- **Export bundle:** `GET /energy-calculations/export?site_id=...` includes `penalty_catalog` (same 18 narratives) next to `calc_types` and `energy_calculations`.

## Equipment metadata (Energy tab)

The **Equipment metadata** tab focuses on **sizing and nameplate fields** that feed these calculators (airflow, motor HP, static pressure, capacities, pump head, etc.). Legacy **controls** and **document provenance** blocks are folded under **Advanced** so existing data is preserved without cluttering the energy workflow.

## Catalog overview (1–18)

1. **Out-of-schedule operation** - `runtime_electric_kw`  
2. **HOA in Hand** - `vfd_affinity_cube`  
3. **Zone hunting / simultaneous HC** - `zone_simultaneous_sensible`  
4. **VAV minimum flow / reheat** - `vav_min_flow_reheat`  
5. **AHU SAT not resetting** - `ahu_sat_sensible_waste`  
6. **Duct static not resetting** - `pressure_ratio_motor_kw`  
7. **Leaking heating valve** - `sensible_coil_leak_kw`  
8. **Dirty filter / fouled coil fan kW** - `fan_filter_dp_kw`  
9. **Missed air-side economizer** - `missed_economizer_cooling`  
10. **ERV / DOAS enthalpy proxy** - `enthalpy_wheel_proxy`  
11. **Overcool + VAV reheat** - `ahu_sat_sensible_waste`  
12. **Chiller on at no load** - `plant_minimum_stack_kw`  
13. **Boiler / HW standby** - `boiler_standby_mix`  
14. **Short-cycle financial proxy** - `short_cycle_financial`  
15. **CHWST not resetting** - `chwst_reset_penalty_kw`  
16. **Pump DP not resetting** - `pressure_ratio_motor_kw`  
17. **Cooling tower fan hunting** - `vfd_affinity_cube`  
18. **COP degradation** - `cop_gap_electric`  

Full trigger text and LaTeX-style math summaries are in the **`description`** field of each seeded row and in `PENALTY_CATALOG` in code.

## Related

- [AI-assisted energy calculations](ai_assisted_energy_calculations) - export / LLM / import workflow  
- [Data model engineering](../howto/data_model_engineering) - Brick + 223P + savings context  
