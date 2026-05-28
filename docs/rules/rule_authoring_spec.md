---
title: Rule Authoring Specification
parent: Fault rules for HVAC
nav_order: 3
---

# Fault Rule Authoring Specification

This is the **contract** for writing new fault-detection rules for the Open-FDD AFDD
stack. It is written so that an external author (contractor or LLM) who has never seen
the codebase can produce a rule YAML that loads, runs, and is accepted without rework.

A submission is **accepted** when it satisfies every item in the
[Acceptance checklist](#13-acceptance-checklist). Read the whole document first — the
[worked example](#11-worked-example-annotated) shows every requirement in one file.

- [1. What a rule is](#1-what-a-rule-is)
- [2. How a rule runs (mental model)](#2-how-a-rule-runs-mental-model)
- [3. File & naming conventions](#3-file--naming-conventions)
- [4. YAML schema (field reference)](#4-yaml-schema-field-reference)
- [5. Rule types](#5-rule-types)
- [6. The ontology (inputs & equipment)](#6-the-ontology-inputs--equipment)
- [7. Expression language reference](#7-expression-language-reference)
- [8. `params` conventions](#8-params-conventions)
- [9. Description & comment style guide (tone)](#9-description--comment-style-guide-tone)
- [10. Anti-patterns (auto-reject)](#10-anti-patterns-auto-reject)
- [11. Worked example (annotated)](#11-worked-example-annotated)
- [12. Submission & handoff](#12-submission--handoff)
- [13. Acceptance checklist](#13-acceptance-checklist)

---

## 1. What a rule is

A rule is a single **`.yaml`** file in `stack/rules/`. It declares:

1. **Which signals** it reads (by Brick class), and **which equipment** it applies to.
2. **A condition** that, when **True**, means a fault is present at that timestamp.

The engine evaluates the condition against time-series data and writes a **boolean flag
column** (`1` = fault, `0` = no fault) for every timestamp. Each rule produces exactly
**one** flag. One fault concept → one file → one flag.

Rules are **data, not code**: no Python is imported, no functions are defined. The only
executable part is a constrained pandas/NumPy **expression string** (§7).

---

## 2. How a rule runs (mental model)

Understand this before writing — it explains why several requirements exist.

1. The FDD loop runs on a schedule. For each piece of **equipment**, it builds a pandas
   **DataFrame**: one row per timestamp, one column per mapped point. Sampling is
   normally **15-minute** intervals (assume this when sizing windows — see §8).
2. Rules whose `equipment_type` does **not** match the equipment are skipped (§6.2).
3. For a matching rule, each declared input (a Brick class) is resolved to a DataFrame
   column via the **Brick TTL** (§6.3). Inputs become named variables in the expression.
4. The expression is evaluated → a boolean Series (the **mask**). `NaN` results become
   `False` (missing data never flags).
5. If `params.rolling_window > 1`, the mask is gated: the flag is `1` only after **N
   consecutive** True samples (debounce). Otherwise any True sample flags.
6. The result is written as the flag column named by `flag`. The flag is also the
   **`fault_id`** — the stable key in the `fault_definitions` and `fault_results` tables
   that drives the UI, Grafana, and the Compliance page.
7. `name`, `description`, `severity`, `category`, and `equipment_type` are synced into
   `fault_definitions` and are what operators read in the product.

**Graceful degradation:** in production (`skip_missing_columns=True`) a rule whose inputs
are not present on a given equipment is **silently skipped** with a log warning — it does
not error, but it also does not fire. Do not assume a rule ran just because it loaded.
When `OFDD_FDD_STRICT_RULES=true`, missing/non-numeric inputs **raise** instead (use this
in test). Design rules so that absent optional context never produces false faults.

---

## 3. File & naming conventions

| Item | Rule | Example |
|------|------|---------|
| File name | `snake_case`, one rule per file, ends `.yaml`. Name it `<equipment>_<symptom>`. | `boiler_hws_off_setpoint.yaml` |
| `name` | `snake_case`, matches the file stem. Globally unique. | `boiler_hws_off_setpoint` |
| `flag` | `snake_case`, ends `_flag`, globally unique, **stable forever** (it is the `fault_id`). | `boiler_hws_off_sp_flag` |

- The **`flag` is a persistent identifier**. Changing it after deployment orphans historical
  fault rows and breaks dashboards. Choose it carefully; never rename it to fix a typo
  without a migration.
- Prefix the file and `name` with the equipment family (`boiler_`, `chiller_`, `ahu_`,
  `fcu_`, `pump_`, `cooling_tower_`) so the directory stays self-sorting.
- Do **not** use uppercase or CamelCase names for new rules (a legacy
  `FanCoil_Heating_NotTracking.yaml` exists; do not copy that style).

---

## 4. YAML schema (field reference)

Top-level keys. Order them as listed below for consistency with existing rules.

| Key | Required | Type | Meaning |
|-----|----------|------|---------|
| `name` | **Yes** | string | Rule id; matches file stem. |
| `description` | **Yes** | string | One-line operator-facing summary. See §9. |
| `type` | **Yes** | enum | One of `expression`, `bounds`, `flatline`, `hunting`, `oa_fraction`, `erv_efficiency`. Defaults to `expression` if omitted — **set it explicitly**. |
| `flag` | **Yes** | string | Flag/`fault_id` column name. Ends `_flag`. |
| `equipment_type` | **Yes** | list[string] | Brick equipment classes the rule applies to. See §6.2. |
| `category` | No | string | `general` (default), `compliance`, or `smoke_test`. `compliance` routes the fault to the Compliance dashboard. |
| `severity` | No | string | `info`, `warning` (default), or `critical`. |
| `inputs` | **Yes** | map | Logical input name → input spec (Brick class + options). See §6.3. |
| `params` | Usually | map | Thresholds, windows, units, gates. Referenced by name in the expression. See §8. |
| `expression` | for `expression` type | string (block) | Boolean pandas expression. See §7. |
| `bounds` | for `bounds` type | per-input | `[low, high]` ranges. See §5. |

> `equipment_type` is listed as required by **our** house style even though the engine
> treats an omitted value as "applies to all equipment." Always scope a rule to its
> equipment family; an unscoped rule runs against every DataFrame and is a common source
> of false positives and wasted compute.

---

## 5. Rule types

Pick the **simplest** type that expresses the fault. Most real rules are `expression`.

### `expression` (default, use for ~90% of rules)
Evaluate a pandas/NumPy boolean expression (§7). Requires `inputs` + `expression`.

### `bounds`
Flag when a sensor is outside `[low, high]`. No expression. Each input carries `bounds`,
unit-aware:

```yaml
type: bounds
inputs:
  Supply_Air_Temperature_Sensor:
    brick: Supply_Air_Temperature_Sensor
    bounds:
      imperial: [40, 150]   # °F
      metric:   [4, 66]     # °C
params:
  units: imperial           # selects which bounds list is used (default imperial)
```
A single `bounds: [low, high]` (no unit map) is also accepted. Multiple inputs in one
bounds rule are OR-ed (any sensor out of range flags).

### `flatline`
Flag when a signal's rolling spread (`max − min`) stays below `tolerance` (stuck sensor).
Params: `tolerance` (default `1e-6`), `window` (samples, default `12`).

### `hunting`
AHU PID hunting: too many operating-state changes in a window. Reads fixed Brick inputs
(`Damper_Position_Command`, `Supply_Fan_Speed_Command`, `Heating_Valve_Command`,
`Cooling_Valve_Command`). Params: `delta_os_max`, `ahu_min_oa_dpr`, `window`.

### `oa_fraction`
AHU economizer / minimum-OA airflow error (ASHRAE GL36 FC6 family). Reads a fixed set of
AHU Brick inputs. Params include `airflow_err_thres`, `ahu_min_oa_cfm_design`,
`oat_rat_delta_min`, `ahu_min_oa_dpr`.

### `erv_efficiency`
Energy-recovery effectiveness outside expected band. Reads `ERV_*` Brick inputs. Params:
`erv_efficiency_min/max_heating/cooling`, `oat_low_threshold`, `oat_high_threshold`,
`oat_rat_delta_min`.

> The last three are **built-in** checks with hard-coded input names and signal handling
> (they auto-scale percent signals). Use them only for the AHU/ERV patterns they encode;
> for anything else write an `expression` rule.

---

## 6. The ontology (inputs & equipment)

### 6.1 Principle: 100% Brick-model driven
Rules **never** name a database column, BACnet object, or historian tag. They name
**Brick 1.4 classes**. The Brick TTL data model maps each Brick point on a given
equipment to its time-series column at runtime. This keeps rules portable across sites.

> Authors do not edit the TTL or the data model. You declare the Brick class you need; if
> a site has a point of that class tagged on the equipment, the rule resolves and runs. If
> not, the rule is skipped for that equipment (§2). When in doubt about whether a Brick
> class exists for the data, **ask** rather than invent one.

### 6.2 `equipment_type` — the equipment vocabulary

`equipment_type` is a list. A rule runs on an equipment only when the equipment's Brick
class matches one of the listed classes (after alias normalization). Use the **canonical
Brick 1.4 long-form** class names:

**HVAC equipment:** `Air_Handling_Unit`, `Boiler`, `Chiller`, `Cooling_Tower`,
`Fan_Coil_Unit`, `Heat_Exchanger`, `Pump`, `Water_Pump`,
`Variable_Air_Volume_Box`, `Variable_Air_Volume_Box_With_Reheat`

**Subsystems / virtual:** `Chilled_Water_System`, `Condenser_Water_System`,
`Hot_Water_System`, `Weather_Service`

**Electrical:** `Building_Electrical_Meter`, `Electrical_Energy_Usage_Sensor`

**Fallback:** `Equipment` (untyped — avoid in new rules)

Accepted **aliases** (case-insensitive; resolved automatically, but prefer the canonical
form): `FCU` → `Fan_Coil_Unit`, `AHU` → `Air_Handling_Unit`,
`VAV` → `Variable_Air_Volume_Box`, `RVAV` → `Variable_Air_Volume_Box_With_Reheat`, plus
space/dash variants (`"Cooling Tower"`, `brick:Cooling-Tower`).

> **Do not invent equipment types.** Values such as `VAV_AHU` or `Heat_Pump` appear in
> some older cookbook examples but are **not** in this vocabulary; a rule scoped to them
> only fires if a site literally tagged equipment with that exact string. New rules must
> use a class from the list above. If you need a class that isn't listed, flag it in
> handoff — it is a data-model change, not a rule change.

### 6.3 Declaring inputs

Each `inputs` entry maps a **logical name** (the variable you use in the expression) to a
spec. **Convention: make the logical name identical to the Brick class.**

```yaml
inputs:
  Hot_Water_Supply_Temperature_Sensor:        # logical name == variable in expression
    brick: Hot_Water_Supply_Temperature_Sensor # Brick class the engine resolves
```

Input spec keys:

| Key | When | Meaning |
|-----|------|---------|
| `brick` | **Always** | Brick 1.4 class to resolve. The stack resolves **only** the `brick` field. |
| `bounds` | `bounds` type only | `[low, high]` or `{imperial: [...], metric: [...]}`. |
| `column` | Never (stack) | Direct column override. Forbidden in stack rules — breaks portability. |

**Disambiguation:** if an equipment has two points of the same Brick class (e.g. two
`Valve_Command`), the data model distinguishes them with `ofdd:mapsToRuleInput`. To target
a specific one, set the logical name to that rule-input token. This is rare — most rules
have one point per class. Prefer distinct Brick classes (`Heating_Valve_Command` vs
`Cooling_Valve_Command`) over disambiguation where the ontology allows it.

> A `Pipeline`/multi-ontology future (`haystack`, `dbo`, `s223` selector fields) is
> reserved in the engine but **not used on this stack**. Provide `brick:` only.

### 6.4 Choosing the right Brick class

- Sensors end in `_Sensor` (`Supply_Air_Temperature_Sensor`).
- Setpoints end in `_Setpoint` (`Hot_Water_Supply_Temperature_Setpoint`).
- Commands end in `_Command` (BMS output, often 0–100 or 0–1 — see §7.3).
- Status/feedback ends in `_Status` (proven on/off).
- Match the existing rules' vocabulary. If two rules read the same physical signal, they
  must use the **same** Brick class. Inconsistent class names fragment the column map.

---

## 7. Expression language reference

Applies to `type: expression`. The expression must evaluate to a **boolean pandas
Series** where **`True` means fault**.

### 7.1 Available names (the whole namespace)
The expression is evaluated in a **locked-down** namespace. Only these exist:

- **Your inputs** — each logical input name is a `pandas.Series` aligned to the DataFrame.
- **Your params** — each scalar in `params` is available by name (e.g. `hws_err`).
- **`np`** — NumPy, for vectorized math: `np.abs`, `np.maximum`, `np.minimum`,
  `np.where`, `np.sqrt`, `np.clip`.
- **`normalize_cmd(series)`** — percent→fraction helper (§7.3).
- **`schedule_occupied`** / **`weather_allows_fdd`** — boolean Series gates, all-`True`
  unless enabled via `params` (§7.4).

There are **no Python builtins** (`abs`, `len`, `min`, `max`, `sum`, `print`, imports,
comprehensions all fail). Use `np.*` and pandas Series methods instead.

### 7.2 Operators & methods
- Logic: `&` (and), `|` (or), `~` (not). **Always parenthesize** each comparison:
  `(a > b) & (c < d)`. Bare `and`/`or` will not work element-wise.
- Comparison: `>`, `>=`, `<`, `<=`, `==`, `!=`.
- Series methods commonly used: `.rolling(window=N).mean()/.sum()/.min()/.max()`,
  `.diff()`, `.abs()`, `.notna()`, `.fillna(...)`.
- Window sizes inside `.rolling(...)` are in **samples** (see §8).

### 7.3 Signal scaling — read this (most common bug)
`_Command` / `_Speed_Command` signals may arrive as **0–1** (fraction) or **0–100**
(percent) depending on the site. A threshold like `> 0.05` silently never (or always)
fires on the wrong scale.

**Rule:** wrap every command/position/speed signal in `normalize_cmd(...)` and write the
threshold as a **fraction (0–1)**:

```text
(normalize_cmd(Heating_Valve_Command) > vlv_open)   # vlv_open: 0.05  → 5% open
```
`normalize_cmd` divides by 100 if any finite sample exceeds 1, else leaves it as-is, and
coerces non-numeric values to NaN. Temperatures, pressures, flows, and setpoints are
physical units — do **not** normalize those.

### 7.4 Schedule & weather gating (optional, recommended for energy rules)
To suppress faults outside occupancy or outside a sensible weather band, enable gates in
`params` and `&`-combine the injected Series:

```yaml
params:
  schedule:
    enabled: true
    weekdays: [0, 1, 2, 3, 4]   # Mon=0 … Sun=6
    start_hour: 8
    end_hour: 17                # last active minute is 16:59
  weather_band:
    enabled: true
    oat_input: Outside_Air_Temperature_Sensor  # must be a declared input
    low: 32
    high: 85
    units: imperial
expression: |
  fan_on & ~schedule_occupied & weather_allows_fdd
```
If `weather_band` is enabled, its `oat_input` **must** be present in `inputs` or the rule
errors. When the gate params are absent, both Series are all-`True` (no gating).

### 7.5 Robustness
- Missing/`NaN` data yields `False` (no false fault) because the engine `fillna(False)`s
  the result. Rely on this rather than special-casing NaN.
- Guard divisions: when computing a ratio (e.g. OA fraction), ensure the denominator can't
  be ~0, or use `np.where(denom != 0, num/denom, 0)`.
- Use rolling aggregates (or `params.rolling_window`, §8) to avoid flagging on a single
  transient sample — equipment has thermal and control lag.

---

## 8. `params` conventions

`params` holds every tunable number. Hard-coded magic numbers in the expression are an
auto-reject (§10) — name them in `params`.

| Param | Meaning |
|-------|---------|
| `rolling_window` | **Debounce gate.** Engine flags only after this many *consecutive* True samples. Also available as a variable in the expression. `12` ≈ 1 h at 5-min data. |
| `units` | `imperial` (default) or `metric`. Selects `bounds` lists. |
| `tolerance`, `window` | `flatline` type tuning. |
| *(your thresholds)* | Any scalar: tolerances, open thresholds, limits. Name them meaningfully. |

**Sampling assumption:** size all sample counts for **5-minute data** (12 samples/hour;
288/day). State the conversion in a comment: `rolling_window: 18  # ~1.5 h at 5-min`.

**Units:** thresholds are **imperial** by default — temperatures in **°F**, pressure in
**inH₂O**, flow in **cfm**. State the unit in a comment on every physical threshold.

**`rolling_window` double-use caveat:** the same `params.rolling_window` value is (a) the
engine consecutive-True debounce **and** (b) a variable you may reference inside
`.rolling(window=rolling_window)`. If you use it both ways the effects compound. Prefer a
separate, clearly named param for an in-expression window if the two purposes differ.

---

## 9. Description & comment style guide (tone)

The voice is **terse, mechanical, operator-facing**. State what is observed and what it
implies — no marketing, no hedging, no first person. Match the existing rules exactly.

### 9.1 Header comment block (above `name:`) — required
1–3 short lines, in this order:
1. **Mechanism + symptom** in one plain sentence: what the equipment is doing and what's
   wrong with it.
2. **Likely root causes**, comma-separated ("Catches …" / "Indicates …").
3. *(optional)* **Tuning note** (sampling assumption, why a threshold is what it is).

```yaml
# Chiller commanded on by BMS but status feedback reports off (or vice versa) for a sustained period.
# Catches failed starters, local/remote switch in wrong position, broken DO or DI, comms issue.
```

### 9.2 `description:` one-liner — required
Operator-facing summary stored in the product. Present tense, **no trailing period**,
symptom-first, with the gating condition after `while`/`vs`:

- `HW supply temp off setpoint while boiler is running`
- `Chiller command vs. status feedback disagree`
- `FCU heating and cooling valves open simultaneously`

Pattern: **`<observable symptom> while <gating condition>`** or
**`<state A> vs <state B> disagree`**. Keep under ~80 characters.

### 9.3 Inline `params` comments — required on physical thresholds
Every threshold carries a `#` comment with **units** and a **one-clause rationale**:

```yaml
params:
  hws_err: 5.0          # °F tolerance — boilers respond slowly
  rolling_window: 18    # ~1.5 h at 5-min sampling
  vlv_open: 0.05        # treat anything above 5% as "open"
```

### 9.4 `severity` / `category` guidance
- `severity`: `info` (diagnostic/no action), `warning` (default — investigate),
  `critical` (immediate risk to comfort/equipment).
- `category`: `general` (default); `compliance` if the fault is a contractual/standards
  KPI surfaced on the Compliance page; `smoke_test` for pipeline-verification rules only.

---

## 10. Anti-patterns (auto-reject)

A submission is rejected if it does any of these:

- Uses a `column:` field, a raw DB/BACnet/historian tag, or any non-Brick input name.
- Invents an `equipment_type` not in §6.2 (e.g. `Heat_Pump`, `VAV_AHU`).
- Omits `equipment_type`, leaving the rule unscoped.
- Compares a `_Command`/`_Speed`/position signal to a fraction threshold **without**
  `normalize_cmd(...)`.
- Hard-codes a threshold inside the expression instead of naming it in `params`.
- Has physical-threshold params with no unit comment.
- Uses Python builtins (`abs`, `min`, `max`, `len`, `and`, `or`, list comprehensions) in
  the expression.
- Produces a non-boolean expression, or one whose `True` means "healthy" (invert it —
  `True` must mean **fault**).
- Reuses an existing `flag`, or packs multiple fault concepts into one file.
- Flags on a single transient sample where lag clearly warrants a rolling window.
- Trailing period or marketing tone in `description`; missing header comment block.

---

## 11. Worked example (annotated)

Every requirement of this spec, in one file:

```yaml
# Boiler commanded on but HW supply temperature persistently far from setpoint.   <- mechanism + symptom
# Slow-responding plant, so a wide tolerance and long window avoid nuisance trips.  <- tuning note
name: boiler_hws_off_setpoint                 # snake_case, == file stem
description: HW supply temp off setpoint while boiler is running   # symptom while condition, no period
type: expression                              # explicit
flag: boiler_hws_off_sp_flag                  # stable fault_id, ends _flag
category: general                             # optional; general is default
severity: warning                             # investigate
equipment_type: [Boiler]                      # canonical Brick 1.4 class

inputs:
  Hot_Water_Supply_Temperature_Sensor:        # logical name == Brick class
    brick: Hot_Water_Supply_Temperature_Sensor
  Hot_Water_Supply_Temperature_Setpoint:
    brick: Hot_Water_Supply_Temperature_Setpoint
  Boiler_Status:
    brick: Boiler_Status

params:
  hws_err: 5.0          # °F tolerance — boilers respond slowly
  rolling_window: 18    # ~1.5 h at 5-min sampling (debounce)

expression: |
  (np.abs(Hot_Water_Supply_Temperature_Sensor - Hot_Water_Supply_Temperature_Setpoint) > hws_err) & (normalize_cmd(Boiler_Status) > 0)
```

Why it passes: Brick-only inputs; scoped to `Boiler`; status normalized; temperature
threshold named with a unit comment; rolling-window debounce; boolean expression where
`True` = fault; terse operator-facing description; header block present.

---

## 12. Submission & handoff

- One rule per `.yaml`, placed in `stack/rules/`.
- Provide, per rule: the YAML, a one-paragraph **rationale** (what data proves the fault),
  and the **physical signals** assumed (with Brick classes and expected units/scale).
- If a needed Brick class or equipment type is **not** in this spec, do **not** invent it
  — list it as an open question in the handoff. It may require a data-model change.
- Validate before submitting (see checklist). The reviewer will load the rule with
  `OFDD_FDD_STRICT_RULES=true` against sample data; rules that error or never resolve are
  returned.

---

## 13. Acceptance checklist

A rule is **done** when all are true:

- [ ] File is `snake_case.yaml`, one rule, `name` matches the stem.
- [ ] `flag` ends `_flag`, is unique, and is treated as permanent.
- [ ] `type` is set explicitly and is one of the six supported types.
- [ ] `description` is symptom-first, no trailing period, ≤ ~80 chars.
- [ ] Header comment block: mechanism+symptom, likely causes, optional tuning note.
- [ ] `equipment_type` is present and uses a canonical class from §6.2.
- [ ] All `inputs` declare `brick:` with a real Brick 1.4 class; no `column:`.
- [ ] Every `_Command`/position/speed signal goes through `normalize_cmd(...)`.
- [ ] All thresholds live in `params`, named, with unit + rationale comments.
- [ ] Sample windows are sized for 5-minute data and documented.
- [ ] Expression returns a boolean Series where `True` = fault; uses `& | ~` with
      parenthesized comparisons and only the allowed namespace (§7.1).
- [ ] Transient-robust: rolling window or rolling aggregate where lag warrants it.
- [ ] Loads and resolves against sample data with strict validation enabled.

---

**See also:** [Overview](overview) · [Expression Rule Cookbook](../expression_rule_cookbook)
· [YAML rules → Pandas (under the hood)](pandas_yaml_dataframes)
· [Test bench rule catalog](test_bench_rule_catalog)
