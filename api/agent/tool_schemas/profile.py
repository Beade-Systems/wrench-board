"""PROFILE_TOOLS tool definitions (re-exported by `api.agent.manifest`)."""

from __future__ import annotations

PROFILE_TOOLS: list[dict] = [
    {
        "type": "custom",
        "name": "profile_get",
        "description": (
            "Read the technician's profile: identity, current level, "
            "verbosity preference, list of available and missing tools, and "
            "summary of mastered/practiced/learning skills with usage counts. "
            "Call once at session start if the system prompt context is stale, "
            "or when the tech reports having updated their profile."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "type": "custom",
        "name": "profile_check_skills",
        "description": (
            "Given a list of candidate skill ids from the catalogue (e.g. "
            "reflow_bga, short_isolation), return for each: the tech's status "
            "(unlearned|learning|practiced|mastered), usage count, whether the "
            "required tools are available, and if not the missing tool ids. "
            "Use BEFORE proposing an action plan so you can adapt depth per step "
            "and skip actions with missing tools."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "candidate_skills": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                },
            },
            "required": ["candidate_skills"],
        },
    },
    {
        "type": "custom",
        "name": "profile_track_skill",
        "description": (
            "Record that the technician has executed an action requiring this "
            "skill, with evidence. Call ONLY after explicit confirmation from "
            "the tech that the action was performed. action_summary must be at "
            "least 20 characters and quote the actual fix (refdes, symptom, "
            "outcome) — the backend rejects thin evidence."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "skill_id": {"type": "string"},
                "evidence": {
                    "type": "object",
                    "properties": {
                        "repair_id": {"type": "string"},
                        "device_slug": {"type": "string"},
                        "symptom": {"type": "string"},
                        "action_summary": {"type": "string", "minLength": 20},
                        "date": {"type": "string"},
                    },
                    "required": ["repair_id", "device_slug", "symptom", "action_summary", "date"],
                },
            },
            "required": ["skill_id", "evidence"],
        },
    },
]
