"""Path-segment safety predicates shared across domains.

`device_slug` and `repair_id` values become directory names under
`memory_root`. Every boundary that accepts one from a client (HTTP route,
Pydantic request model, agent tool payload) must reject anything that could
escape that subtree. Pure functions, no I/O — the HTTP-flavoured wrappers
(raising `HTTPException`) live next to the routers that use them.
"""

from __future__ import annotations

import re

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
REPAIR_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def is_safe_slug(slug: str | None) -> bool:
    """True when `slug` is canonical kebab-case with no `..` sequence."""
    return bool(slug) and SLUG_RE.fullmatch(slug) is not None and ".." not in slug


def is_safe_id(value: str | None) -> bool:
    """True when `value` is a single safe path segment (repair / conv ids)."""
    return bool(value) and value not in {".", ".."} and REPAIR_ID_RE.fullmatch(value) is not None
