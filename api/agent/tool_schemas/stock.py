"""STOCK_TOOLS tool definitions (re-exported by `api.agent.manifest`)."""

from __future__ import annotations

STOCK_TOOLS: list[dict] = [
    {
        "type": "custom",
        "name": "stock_search",
        "description": (
            "Search the technician's donor stock for a part matching the given "
            "electrical signature. Returns exact_matches (drop-in compatible: "
            "same type, package, value, MPN, with voltage_rating ≥ requested) "
            "or empty_reason when nothing matches. Call this proactively after "
            "confirming a cause that requires component replacement, BEFORE "
            "recommending where to source the part."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "type": {
                    "type": "string",
                    "enum": ["capacitor", "resistor", "inductor", "diode", "ic",
                             "transistor", "ferrite", "connector"],
                },
                "value_canonical": {"type": "string",
                                    "description": "e.g. '0.1uF', '10k', or full MPN for ICs"},
                "package": {"type": "string", "description": "e.g. '0402', 'QFN-24'"},
                "mpn": {"type": "string", "description": "exact MPN (required for ICs)"},
                "voltage_min": {"type": "number",
                                "description": "minimum voltage_rating (caps only)"},
                "exclude_donors": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["type"],
        },
    },
    {
        "type": "custom",
        "name": "stock_consume",
        "description": (
            "Mark a component as harvested from a donor (no longer available for "
            "future searches). Call this when the technician confirms they took a "
            "part out of a stocked donor board."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "donor_id": {"type": "string"},
                "refdes": {"type": "string"},
                "notes": {"type": "string"},
            },
            "required": ["donor_id", "refdes"],
        },
    },
    {
        "type": "custom",
        "name": "stock_mark_donor",
        "description": (
            "Declare a board as a donor in the technician's physical stock. Use "
            "ONLY when the technician explicitly says they have this board on "
            "their bench as a donor. Returns the generated donor_id."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "device_slug": {"type": "string",
                                "description": "must match an existing memory/{slug}/ directory"},
                "label": {"type": "string"},
                "condition": {"type": "string",
                              "enum": ["donor_only", "potentially_repairable"],
                              "default": "donor_only"},
            },
            "required": ["device_slug", "label"],
        },
    },
    {
        "type": "custom",
        "name": "stock_unmark_donor",
        "description": (
            "Remove a donor from physical stock (e.g., the tech repaired it or "
            "threw it out)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"donor_id": {"type": "string"}},
            "required": ["donor_id"],
        },
    },
    {
        "type": "custom",
        "name": "stock_list_donors",
        "description": (
            "List all donors currently in physical stock with their availability "
            "summary. Use when the technician asks 'what do I have in stock' or "
            "to inform a search strategy."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
]
