"""RECALL_TOOLS tool definitions (re-exported by `api.agent.manifest`)."""

from __future__ import annotations

# Direct-mode memory recall (parity with the managed agent's FUSE-mounted
# stores). Read-only wrappers over `api.agent.recall`. Always present — the
# direct agent has no FUSE mount, so these are its only window onto field
# reports / patterns / playbooks. Managed mode does NOT use this manifest.
RECALL_TOOLS: list[dict] = [
    {
        "type": "custom",
        "name": "mb_recall_field_reports",
        "description": (
            "Recall confirmed findings from PAST repairs of THIS device "
            "(per-device memory that grows over time). Call it before "
            "concluding, to check whether this exact fault was already "
            "diagnosed here. Filter by free-text `query` and/or `refdes`."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Keyword(s) matched across symptom/cause/refdes.",
                },
                "refdes": {"type": "string", "description": "Restrict to one component."},
                "limit": {"type": "integer", "default": 8},
            },
        },
    },
    {
        "type": "custom",
        "name": "mb_search_patterns",
        "description": (
            "Search global cross-device failure archetypes (short-to-GND, "
            "thermal cascade, BGA lift, bench anti-patterns). Call it to "
            "recognise the TYPE of fault and how to reason about it."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
    {
        "type": "custom",
        "name": "mb_search_playbooks",
        "description": (
            "Search global diagnostic protocol templates by symptom. ALWAYS "
            "call this BEFORE bv_propose_protocol: if a playbook matches, lift "
            "its validated step sequence instead of reinventing one."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "symptom": {
                    "type": "string",
                    "description": "Symptom keyword, e.g. no-power, no-boot, usb-no-charge.",
                },
            },
            "required": ["symptom"],
        },
    },
]
