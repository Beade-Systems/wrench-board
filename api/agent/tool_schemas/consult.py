"""CONSULT_TOOLS tool definitions (re-exported by `api.agent.manifest`)."""

from __future__ import annotations

CONSULT_TOOLS: list[dict] = [
    {
        "type": "custom",
        "name": "consult_specialist",
        "description": (
            "Delegate a focused question to a specialist sub-agent on a "
            "different model tier. Use this when your tier is too shallow "
            "(Haiku on multi-step electrical reasoning) or you want a quick "
            "second opinion (Opus consulting Sonnet for a sanity check). "
            "The sub-agent runs as an isolated Managed-Agent session, "
            "returns only its final text answer, and CANNOT call any tool — "
            "tell it everything it needs in `context`. The call costs a "
            "separate session-hour on the chosen tier. Avoid recursive "
            "consultations. Good triggers: 'this needs Opus-grade reasoning', "
            "'check my hypothesis with a second model'. Bad triggers: "
            "'classify this string' (too cheap), 'continue the conversation' "
            "(use your own turn)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "tier": {
                    "type": "string",
                    "enum": ["fast", "normal", "deep"],
                    "description": (
                        "Specialist tier. `fast`=Haiku 4.5 (cheap quick "
                        "lookups), `normal`=Sonnet 4.6 (balanced), "
                        "`deep`=Opus 4.8 (best multi-step reasoning). "
                        "Don't pick your own tier — the dispatcher will reject "
                        "self-consultation."
                    ),
                },
                "query": {
                    "type": "string",
                    "description": "The focused question for the specialist.",
                },
                "context": {
                    "type": "string",
                    "description": (
                        "Self-contained briefing: device, symptoms, prior "
                        "measurements, hypotheses already ruled out. The "
                        "sub-agent has no access to your tools or memory."
                    ),
                },
            },
            "required": ["tier", "query"],
        },
    },
]
