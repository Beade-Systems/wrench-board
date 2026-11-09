"""PROTOCOL_TOOLS tool definitions (re-exported by `api.agent.manifest`)."""

from __future__ import annotations

PROTOCOL_TOOLS: list[dict] = [
    {
        "type": "custom",
        "name": "bv_propose_protocol",
        "description": (
            "Emit an ordered, typed diagnostic protocol that the UI "
            "renders visually (floating cards on the board + side "
            "wizard, or inline cards when no board). Each step has a "
            "type (numeric/boolean/observation/ack), a target refdes, "
            "an instruction and a rationale. Call this tool ONLY after "
            "matching a rule (confidence ≥ 0.6) or identifying ≥ 2 "
            "likely_causes. Typical trigger: when the tech, suspect "
            "already identified, asks 'how do I find / locate / test / "
            "track it down', emit the hunt protocol (3-6 steps) rather "
            "than explaining in prose. ONE active protocol at a time — "
            "re-emitting replaces the previous one. Cap: 12 steps. "
            "REQUIRES TECH CONFIRMATION: the proposal is shown in a "
            "modal first; the tech accepts or rejects before the "
            "protocol is materialised. On reject, the tool call returns "
            "is_error with the tech's reason — do not re-emit the same "
            "plan; ask a clarifying question or propose a different "
            "approach."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "rationale": {"type": "string"},
                "rule_inspirations": {
                    "type": "array", "items": {"type": "string"},
                },
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": {
                                "type": "string",
                                "enum": ["numeric", "boolean", "observation", "ack"],
                            },
                            "target": {"type": ["string", "null"]},
                            "test_point": {"type": ["string", "null"]},
                            "instruction": {"type": "string"},
                            "rationale": {"type": "string"},
                            "unit": {"type": ["string", "null"]},
                            "nominal": {"type": ["number", "null"]},
                            "pass_range": {
                                "type": ["array", "null"],
                                "items": {"type": "number"},
                                "minItems": 2, "maxItems": 2,
                            },
                            "expected": {"type": ["boolean", "null"]},
                        },
                        "required": ["type", "instruction", "rationale"],
                    },
                },
            },
            "required": ["title", "rationale", "steps"],
        },
    },
    {
        "type": "custom",
        "name": "bv_update_protocol",
        "description": (
            "Modify the active protocol: insert (new step after an "
            "anchor), skip (the tech lacks the tool or you decide to "
            "pass), replace_step (a pending step that no longer makes "
            "sense), reorder (the pending steps — the active step "
            "stays first), complete_protocol (everything done, give a "
            "1-sentence verdict), abandon_protocol (the tech declines). "
            "reason is REQUIRED and will be logged in the history."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "insert", "skip", "replace_step", "reorder",
                        "complete_protocol", "abandon_protocol",
                    ],
                },
                "reason": {"type": "string"},
                "step_id": {"type": ["string", "null"]},
                "after": {"type": ["string", "null"]},
                "new_step": {"type": ["object", "null"]},
                "new_order": {
                    "type": ["array", "null"],
                    "items": {"type": "string"},
                },
                "verdict": {"type": ["string", "null"]},
            },
            "required": ["action", "reason"],
        },
    },
    {
        "type": "custom",
        "name": "bv_record_step_result",
        "description": (
            "Persist a step result yourself (useful when the tech "
            "reports the value in chat rather than via the UI: "
            "'VBUS = 4.8V'). For numeric, value is a number + unit. "
            "For boolean, value is true/false. For observation, value "
            "is text. For ack, value=null. skip_reason set = step "
            "marked skipped without a measurement. The state machine "
            "then auto-advances to the next pending step."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "step_id": {"type": "string"},
                "value": {},
                "unit": {"type": ["string", "null"]},
                "observation": {"type": ["string", "null"]},
                "skip_reason": {"type": ["string", "null"]},
            },
            "required": ["step_id"],
        },
    },
    {
        "type": "custom",
        "name": "bv_get_protocol",
        "description": (
            "Read the full active protocol (steps, statuses, results, "
            "history). Use when resuming a session or when you suspect "
            "state drift after a disconnect. Returns {active: false} "
            "if no protocol is active."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
]
