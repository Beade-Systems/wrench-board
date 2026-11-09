"""BV_TOOLS tool definitions (re-exported by `api.agent.manifest`)."""

from __future__ import annotations

BV_TOOLS: list[dict] = [
    {
        "type": "custom",
        "name": "bv_scene",
        "description": (
            "Compose a diagnostic scene on the board in ONE call: "
            "reset, highlights, annotations, arrows, focus, dim. "
            "PREFER this tool whenever you want to show several "
            "elements tied to the same hypothesis (e.g. highlight 3 "
            "PMICs + annotate their role + draw an arrow from the "
            "suspect to its rail). Sub-ops run in the order reset → "
            "highlights → annotations → arrows → focus → dim and emit "
            "a single group of events. The atomic tools "
            "(bv_highlight, bv_annotate, bv_draw_arrow…) remain for "
            "isolated actions (one refdes, one gesture). Soft cap: "
            "~10 highlights, 10 annotations, 5 arrows per scene."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "reset": {
                    "type": "boolean",
                    "default": False,
                    "description": "Clear all overlays before applying the scene.",
                },
                "highlights": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "refdes": {
                                "oneOf": [
                                    {"type": "string"},
                                    {"type": "array", "items": {"type": "string"}},
                                ],
                            },
                            "color": {
                                "type": "string",
                                "enum": ["accent", "warn", "mute"],
                                "default": "accent",
                            },
                        },
                        "required": ["refdes"],
                    },
                },
                "annotations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "refdes": {"type": "string"},
                            "label": {"type": "string"},
                        },
                        "required": ["refdes", "label"],
                    },
                },
                "arrows": {
                    "type": "array",
                    "description": (
                        "Directional arrows refdes→refdes. Include them "
                        "EVERY TIME the scene describes a directed relation: "
                        "boot order, signal path, power propagation, fault "
                        "cascade, upstream→downstream causation. One arrow "
                        "per hop (e.g. boot PMIC→SoC→DRAM = 2 arrows). A "
                        "scene without arrows is a static highlight; a scene "
                        "WITH arrows tells the story the tech needs to see."
                    ),
                    "items": {
                        "type": "object",
                        "properties": {
                            "from_refdes": {"type": "string"},
                            "to_refdes": {"type": "string"},
                        },
                        "required": ["from_refdes", "to_refdes"],
                    },
                },
                "focus": {
                    "type": "object",
                    "properties": {
                        "refdes": {"type": "string"},
                        "zoom": {"type": "number", "default": 1.4},
                    },
                    "required": ["refdes"],
                },
                "dim_unrelated": {"type": "boolean", "default": False},
            },
        },
    },
    {
        "type": "custom",
        "name": "bv_highlight",
        "description": "Highlight one or more components on the PCB canvas.",
        "input_schema": {
            "type": "object",
            "properties": {
                "refdes": {
                    "oneOf": [
                        {"type": "string"},
                        {"type": "array", "items": {"type": "string"}},
                    ],
                },
                "color": {"type": "string", "enum": ["accent", "warn", "mute"], "default": "accent"},
                "additive": {"type": "boolean", "default": False},
            },
            "required": ["refdes"],
        },
    },
    {
        "type": "custom",
        "name": "bv_focus",
        "description": "Pan/zoom the PCB canvas to a specific component. Auto-flips the board if the component is on the hidden side.",
        "input_schema": {
            "type": "object",
            "properties": {
                "refdes": {"type": "string"},
                "zoom": {"type": "number", "default": 1.4},
            },
            "required": ["refdes"],
        },
    },
    {
        "type": "custom",
        "name": "bv_reset_view",
        "description": "Reset the PCB canvas: clear all highlights, annotations, arrows, dim, filter. The technician's manual selection is preserved.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "type": "custom",
        "name": "bv_flip",
        "description": "Flip the visible PCB side (top ↔ bottom).",
        "input_schema": {
            "type": "object",
            "properties": {"preserve_cursor": {"type": "boolean", "default": False}},
        },
    },
    {
        "type": "custom",
        "name": "bv_annotate",
        "description": "Attach a text label to a component on the canvas.",
        "input_schema": {
            "type": "object",
            "properties": {
                "refdes": {"type": "string"},
                "label": {"type": "string"},
            },
            "required": ["refdes", "label"],
        },
    },
    {
        "type": "custom",
        "name": "bv_dim_unrelated",
        "description": "Visually dim all components not currently highlighted — focuses the technician's attention.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "type": "custom",
        "name": "bv_highlight_net",
        "description": "Highlight every pin on a given net (rail/signal tracing).",
        "input_schema": {
            "type": "object",
            "properties": {"net": {"type": "string"}},
            "required": ["net"],
        },
    },
    {
        "type": "custom",
        "name": "bv_show_pin",
        "description": "Point to a specific pin of a component (e.g. for a probe instruction).",
        "input_schema": {
            "type": "object",
            "properties": {
                "refdes": {"type": "string"},
                "pin": {"type": "integer", "minimum": 1},
            },
            "required": ["refdes", "pin"],
        },
    },
    {
        "type": "custom",
        "name": "bv_draw_arrow",
        "description": (
            "Draw a directional arrow on the PCB from one refdes to another. "
            "Materializes a directed relation the tech needs to SEE: signal "
            "path, power propagation, boot dependency, causation chain, "
            "upstream→downstream link. RULE: every time your reply describes "
            "such a relation in words (\"the rail comes from U2\", \"U7 "
            "drives the SoC\", \"boot order: PMIC → SoC → DRAM\"), draw the "
            "matching arrow(s) — one per hop. Words alone aren't enough on "
            "this UI; the diagram is the explanation. For multi-hop chains "
            "or arrows combined with highlights/annotations, prefer "
            "bv_scene.arrows in ONE call. Use bv_draw_arrow only for an "
            "isolated single-hop gesture."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "from_refdes": {"type": "string"},
                "to_refdes": {"type": "string"},
            },
            "required": ["from_refdes", "to_refdes"],
        },
    },
    {
        "type": "custom",
        "name": "bv_measure",
        "description": "Return the physical distance (mm) between two components' centers.",
        "input_schema": {
            "type": "object",
            "properties": {
                "refdes_a": {"type": "string"},
                "refdes_b": {"type": "string"},
            },
            "required": ["refdes_a", "refdes_b"],
        },
    },
    {
        "type": "custom",
        "name": "bv_filter_by_type",
        "description": "Show only components whose refdes starts with a given prefix. The prefix must be the letter(s) used in the refdes convention (e.g. 'C' for capacitors, 'U' for ICs, 'R' for resistors), not a category name like 'capacitor'.",
        "input_schema": {
            "type": "object",
            "properties": {"prefix": {"type": "string"}},
            "required": ["prefix"],
        },
    },
    {
        "type": "custom",
        "name": "bv_layer_visibility",
        "description": "Toggle visibility of a PCB layer (top or bottom).",
        "input_schema": {
            "type": "object",
            "properties": {
                "layer": {"type": "string", "enum": ["top", "bottom"]},
                "visible": {"type": "boolean"},
            },
            "required": ["layer", "visible"],
        },
    },
]
