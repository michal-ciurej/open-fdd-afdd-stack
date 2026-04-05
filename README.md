# Open-FDD AFDD stack

[![Discord](https://img.shields.io/badge/Discord-Join%20Server-5865F2.svg?logo=discord&logoColor=white)](https://discord.gg/Ta48yQF8fC)
[![CI](https://github.com/bbartling/open-fdd-afdd-stack/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bbartling/open-fdd-afdd-stack/actions/workflows/ci.yml)
![MIT License](https://img.shields.io/badge/license-MIT-green.svg)
![Development Status](https://img.shields.io/badge/status-Beta-blue)
![Python](https://img.shields.io/badge/Python-3.9+-blue?logo=python&logoColor=white)
[![Engine (PyPI)](https://img.shields.io/pypi/v/open-fdd?label=engine%20(PyPI))](https://pypi.org/project/open-fdd/)

<div align="center">

![open-fdd logo](https://raw.githubusercontent.com/bbartling/open-fdd-afdd-stack/main/image.png)

</div>

This repository is the **full on-prem AFDD platform**: Docker Compose, **FastAPI** data-model API, BACnet and weather scrapers, **FDD loop**, optional Grafana/Caddy, and the **React** dashboard. The **rules engine** is **not** vendored here — containers and this package install **`open-fdd` from [PyPI](https://pypi.org/project/open-fdd/)** (`open_fdd.engine`, YAML rules on pandas). Platform code lives under the Python package **`openfdd_stack.platform`**.

---

## Documentation

- **This stack** (bootstrap, Compose, API, drivers, UI): **[GitHub Pages — open-fdd-afdd-stack](https://bbartling.github.io/open-fdd-afdd-stack/)** (built from `docs/` on push).
- **Engine / PyPI library** (`RuleRunner`, rule YAML, pandas): **[open-fdd documentation](https://bbartling.github.io/open-fdd/)** — source [bbartling/open-fdd](https://github.com/bbartling/open-fdd), package [PyPI `open-fdd`](https://pypi.org/project/open-fdd/).

---

## Quick start (Linux + Docker)

Prerequisites: **Docker** + **Docker Compose**, **Git**. Clone **this** repo (not only `open-fdd`).

```bash
git clone https://github.com/bbartling/open-fdd-afdd-stack.git
cd open-fdd-afdd-stack
chmod +x scripts/bootstrap.sh
./scripts/bootstrap.sh --help
```

Example HTTP bootstrap (see engine docs for BACnet addressing and auth notes):

```bash
printf '%s' 'YourSecurePassword' | ./scripts/bootstrap.sh \
  --bacnet-address 192.168.204.16/24:47808 \
  --bacnet-instance 12345 \
  --user ben \
  --password-stdin
```

Compose file: **`stack/docker-compose.yml`**. API module path: **`openfdd_stack.platform.api.main:app`**. FDD loop: **`python -m openfdd_stack.platform.drivers.run_rule_loop`**.

---

## Python layout

| Install | Role |
|--------|------|
| **`open-fdd`** (PyPI) | `open_fdd.engine`, `open_fdd.schema`, `open_fdd.reports` |
| **`openfdd-afdd-stack`** (this repo, `pip install -e .`) | `openfdd_stack.platform` (API, DB loop, drivers) |

Local development (co-developing engine + stack):

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -e "/path/to/open-fdd[dev]"
pip install -e ".[dev]"
pytest openfdd_stack/tests -v
```

**Default / CI:** install only the stack package (`pip install -e ".[dev]"`). Dependencies resolve **`open-fdd` from PyPI** (version range in `pyproject.toml`). The CI workflow asserts `import open_fdd` loads from **`site-packages`**, matching production containers.

---

## Images

Same branding assets as the engine repo: `image.png`, `OpenFDD_system_pyramid.png`, schematics (see repo root).

---

## License

MIT
