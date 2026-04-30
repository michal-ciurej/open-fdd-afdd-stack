"""
Per-equipment column_map builder (DB-scoped).

Why this exists:
The Brick TTL resolver builds a *global* column_map for the whole model. When many
equipments share the same Brick class and fdd_input (e.g. FCU zone temperatures),
global dict keys collide and only one equipment "wins".

For per-equipment faulting we must bind inputs against the equipment's own points,
so this module builds a column_map from DB rows filtered by equipment_id.
"""

from __future__ import annotations

from collections import Counter
from typing import Dict, Optional

from openfdd_stack.platform.database import get_conn


def build_equipment_column_map(
    *,
    site_id: str,
    equipment_id: str,
) -> Dict[str, str]:
    """
    Build an engine column_map for ONE equipment from DB `points`.

    Returns mapping:
      - Brick class -> external_id when unambiguous within the equipment
      - BrickClass|fdd_input -> external_id when multiple points share Brick class
      - fdd_input -> external_id when present (convenient alias)

    Notes:
      - This is scoped to one equipment, so it is safe for many equipments to share
        the same Brick/fdd_input keys across the site.
      - When duplicates still exist within ONE equipment and there is no fdd_input,
        we do not guess; those inputs will remain unbound and the engine will skip.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT external_id, brick_type, fdd_input
                FROM points
                WHERE (site_id = %s OR site_id::text = %s)
                  AND equipment_id = %s
                  AND external_id IS NOT NULL AND external_id <> ''
                ORDER BY external_id
                """,
                (site_id, site_id, equipment_id),
            )
            rows = cur.fetchall()

    if not rows:
        return {}

    brick_types = [r.get("brick_type") for r in rows if r.get("brick_type")]
    counts = Counter(str(bt) for bt in brick_types)

    mapping: Dict[str, str] = {}
    # Track ambiguous brick types without fdd_input so we can skip them.
    ambiguous_no_input: set[str] = set()
    if counts:
        for bt, n in counts.items():
            if n > 1:
                ambiguous_no_input.add(bt)

    for r in rows:
        ext = (r.get("external_id") or "").strip()
        brick = (r.get("brick_type") or "").strip()
        rule_input: Optional[str] = (
            (r.get("fdd_input") or "").strip() if r.get("fdd_input") else None
        )
        if not ext or not brick:
            continue

        # Disambiguation within the equipment when multiple points share a Brick class.
        if counts.get(brick, 0) > 1:
            if rule_input:
                mapping.setdefault(f"{brick}|{rule_input}", ext)
            else:
                # ambiguous within this equipment; do not set a plain Brick key
                continue
        else:
            mapping.setdefault(brick, ext)

        if rule_input:
            mapping.setdefault(rule_input, ext)

    return mapping

