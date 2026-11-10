"""Board-delta generation endpoint.

POST /pipeline/packs/{slug}/board-delta  — generate + store a per-revision delta
GET  /pipeline/packs/{slug}/board-delta/{board}  — retrieve a stored delta
"""
from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from anthropic import AsyncAnthropic
from fastapi import APIRouter, Form, Header, HTTPException

from api.config import get_settings
from api.pipeline.board_delta.agent import generate_board_delta
from api.pipeline.board_delta.store import normalize_board_number, read_delta, write_delta
from api.pipeline.build_metering import report_delta_usage
from api.pipeline.routes._helpers import _validate_slug

router = APIRouter()


@router.post("/packs/{slug}/board-delta")
async def create_board_delta(
    slug: str,
    device_label: str = Form(...),
    board_number: str = Form(...),
    x_owner_ref: str | None = Header(default=None, alias="X-Owner-Ref"),
):
    """Generate and persist a board-delta for a given device revision.

    Calls the Claude agent, writes the result under
    ``memory/{slug}/board_deltas/{board}.json``, and fires one
    ``kind='delta'`` metering event (no-op on self-host).
    """
    _validate_slug(slug)  # becomes memory/{slug}/board_deltas/ — no traversal
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise HTTPException(
            status_code=503,
            detail={"reason": "missing_api_key", "message": "ANTHROPIC_API_KEY is not set"},
        )
    client = AsyncAnthropic(api_key=settings.anthropic_api_key, max_retries=settings.anthropic_max_retries)
    delta = await generate_board_delta(
        client=client,
        model=settings.anthropic_model_main,
        device_label=device_label,
        board_number=board_number,
    )
    delta.generated_by_tenant = x_owner_ref
    delta.generated_at = datetime.now(UTC).isoformat()
    write_delta(memory_root=Path(settings.memory_root), device_slug=slug, delta=delta)
    report_delta_usage(
        owner_ref=x_owner_ref,
        model=settings.anthropic_model_main,
        input_tokens=0,
        output_tokens=0,
        event_id=f"{slug}:delta:{normalize_board_number(board_number)}",
        kind="delta",
    )
    return delta.model_dump()


@router.get("/packs/{slug}/board-delta/{board}")
async def get_board_delta(slug: str, board: str):
    """Return a stored board-delta, or 404 if not yet generated."""
    _validate_slug(slug)
    settings = get_settings()
    delta = read_delta(
        memory_root=Path(settings.memory_root),
        device_slug=slug,
        board_number=board,
    )
    if delta is None:
        raise HTTPException(status_code=404, detail=f"No board delta for {board!r}")
    return delta.model_dump()
