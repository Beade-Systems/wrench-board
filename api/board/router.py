"""HTTP router for board-file parsing — stateless: accepts an upload, returns parsed JSON."""

from __future__ import annotations

import asyncio
import gzip
import json
from pathlib import Path

from fastapi import APIRouter, File, Header, HTTPException, Response, UploadFile

from api.board import render_store
from api.board.byte_cache import ByteCache
from api.board.http_errors import import_errors
from api.board.imports import board_import_service
from api.board.parser.base import (
    BoardParserError,
    InvalidBoardFile,
    MalformedHeaderError,
    MissingFZKeyError,
    ObfuscatedFileError,
    PinPartMismatchError,
    UnsupportedFormatError,
    parser_for,
)
from api.config import get_settings

router = APIRouter(prefix="/api/board", tags=["board"])

# Process-local cache for /render. Boardview parsing is the heaviest
# synchronous work the API does (a 5 MB .tvw takes ~5 s to parse +
# serialise on a 5700X3D), and `renderDashboardData` hits this endpoint
# every time the user opens a repair dashboard — just to count
# net_diagnostics for the "diagnostic-ready" badge. Caching by
# (resolved file path, mtime) gives byte-exact invalidation: if the
# tech swaps the active pin or re-uploads a board, the new file has a
# new path or mtime and misses the cache. Entries are encoded bytes, not
# dicts: encoding a 15 MB payload costs ~2 s of event-loop time per response
# when left to FastAPI, and bytes are far smaller in memory. Gzip is the primary
# form (also persisted by render_store); plain JSON is derived from it on demand
# as a separate LRU entry, so it ages out independently.
_render_cache = ByteCache(max_bytes=128 << 20, max_entries=32)
_RENDER_GZIP_LEVEL = 5


def _build_render_gzip(path: Path, mtime: float) -> bytes:
    from api.board.render import to_render_payload

    entry = render_store.entry_for(path)
    stored = render_store.load(entry)
    if stored is not None:
        return stored
    payload = to_render_payload(parser_for(path).parse_file(path))
    body = gzip.compress(
        json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode(),
        _RENDER_GZIP_LEVEL,
    )
    # `entry` hashes the file as it was before the parse.
    if path.stat().st_mtime == mtime:
        render_store.save(entry, body)
    return body


def encode_render(path: Path, mtime: float, *, gzipped: bool = False) -> bytes:
    """Encoded render payload for a boardview file. Blocking: call off-loop."""
    key = (str(path), mtime)
    compressed = _render_cache.get_or_build(
        (*key, "gzip"), lambda: _build_render_gzip(path, mtime)
    )
    if gzipped:
        return compressed
    return _render_cache.get_or_build(key, lambda: gzip.decompress(compressed))


def render_gzip_enabled() -> bool:
    """Mirrors `_install_compression`: the hosted front-door needs plain bodies."""
    return not get_settings().engine_service_token


@router.post("/parse")
async def parse_board(
    file: UploadFile = File(...),  # noqa: B008
    x_owner_ref: str | None = Header(default=None, alias="X-Owner-Ref"),
) -> Response:
    with import_errors():
        body = await asyncio.to_thread(
            board_import_service.parse_json,
            file.file,
            file.filename or "upload.brd",
            get_settings().board_upload_max_bytes,
            file.size,
            x_owner_ref,
        )
    return Response(body, media_type="application/json")


@router.get("/render")
async def render_board(
    slug: str,
    x_owner_ref: str | None = Header(default=None, alias="X-Owner-Ref"),
    accept_encoding: str = Header(default=""),
) -> Response:
    """Return the Three.js render payload for the active boardview of a slug.

    Tenant-scopé (T9) : le cloud injecte `X-Owner-Ref` (= tenant_id) sur le trafic
    proxifié. Managé → STRICTEMENT le boardview épinglé par CE tenant ; un tenant
    sans boardview actif obtient 404 (jamais le board d'un autre — c'était la fuite).
    Self-host (en-tête absent) → chaîne globale historique (`active_sources.json` →
    `board_assets/{slug}.<ext>` → `memory/{slug}/uploads/*-boardview-*`), inchangé.
    Returns 404 when no boardview is on disk; 422 / 415 when the file fails to parse.
    """
    # Local import — avoids dragging the pipeline package into the board
    # router's module-load graph (FastAPI registers them in opposite order).
    from api.pipeline import _find_owner_boardview

    settings = get_settings()
    pack_dir = Path(settings.memory_root) / slug
    path = _find_owner_boardview(slug, pack_dir, x_owner_ref)
    if path is None:
        raise HTTPException(
            status_code=404,
            detail={
                "detail": "no-boardview",
                "message": f"no boardview on disk for slug={slug!r}",
            },
        )
    try:
        mtime = path.stat().st_mtime
    except OSError as e:
        raise HTTPException(
            status_code=500,
            detail={"detail": "io-error", "message": str(e)},
        ) from e
    gzipped = render_gzip_enabled() and "gzip" in accept_encoding
    try:
        # Offload hors event-loop (cf. /parse) : un render de gros boardview ne
        # doit pas geler le moteur ni sérialiser avec les autres requêtes.
        body = await asyncio.to_thread(encode_render, path, mtime, gzipped=gzipped)
    except UnsupportedFormatError as e:
        raise HTTPException(
            status_code=415,
            detail={"detail": "unsupported-format", "message": str(e)},
        ) from e
    except (
        ObfuscatedFileError,
        MalformedHeaderError,
        PinPartMismatchError,
        MissingFZKeyError,
        InvalidBoardFile,
        BoardParserError,
    ) as e:
        raise HTTPException(
            status_code=422,
            detail={"detail": "parse-error", "message": str(e)},
        ) from e
    except OSError as e:
        raise HTTPException(
            status_code=500,
            detail={"detail": "io-error", "message": str(e)},
        ) from e
    # A preset Content-Encoding makes GZipMiddleware pass the body through.
    headers = {"Vary": "Accept-Encoding"}
    if gzipped:
        headers["Content-Encoding"] = "gzip"
    return Response(body, media_type="application/json", headers=headers)
