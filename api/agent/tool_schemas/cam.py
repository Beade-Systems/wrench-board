"""CAM_TOOLS tool definitions (re-exported by `api.agent.manifest`)."""

from __future__ import annotations

CAM_TOOLS: list[dict] = [
    {
        "type": "custom",
        "name": "cam_capture",
        "description": (
            "Acquire a still frame from the technician's selected camera "
            "(microscope, webcam, etc.). Use when you need a fresh visual "
            "on a specific component or anomaly. The tech has already "
            "framed and focused — no parameters needed beyond an optional "
            "reason for traceability. Returns the captured image as a "
            "tool_result the model can read directly."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Brief reason for the capture (logged, not shown to the tech).",
                }
            },
        },
    },
]
