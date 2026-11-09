"""Persistent PCB library, using the same parsers as the repair workbench.

Each owner has a separate collection under memory/_pcb_library. Originals,
normalized boards and small catalog records are published together by rename.
The gateway supplies X-Owner-Ref, as for the existing board and stock APIs.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, File, Header, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from api.board.http_errors import import_errors
from api.board.imports import import_into_library
from api.board.library_store import LibraryBoardNotFound, LibraryStore
from api.board.parser.base import _REGISTRY
from api.config import get_settings

router = APIRouter(prefix="/api/library", tags=["pcb-library"])


def _store(owner: str | None) -> LibraryStore:
    return LibraryStore(Path(get_settings().memory_root), owner)


@contextmanager
def _not_found():
    try:
        yield
    except LibraryBoardNotFound as error:
        raise HTTPException(404, "PCB nicht gefunden.") from error


class BoardUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=160)
    notes: str | None = Field(default=None, max_length=10000)
    favorite: bool | None = None


class WorklistItem(BaseModel):
    refdes: str = Field(min_length=1, max_length=200)
    note: str = Field(default="", max_length=2000)
    done: bool = False
    pinned: bool = False


class Worklist(BaseModel):
    items: list[WorklistItem] = Field(max_length=2000)


@router.get("")
def library_info() -> dict:
    return {
        "extensions": sorted(_REGISTRY),
        "max_upload_bytes": get_settings().board_upload_max_bytes,
    }


@router.get("/boards")
def list_boards(owner: str | None = Header(default=None, alias="X-Owner-Ref")) -> dict:
    return {"boards": _store(owner).list()}


@router.post("/boards")
async def import_board(
    file: UploadFile = File(...),  # noqa: B008
    owner: str | None = Header(default=None, alias="X-Owner-Ref"),
) -> dict:
    with import_errors():
        return await asyncio.to_thread(
            import_into_library,
            file.file,
            file.filename or "upload.brd",
            get_settings().board_upload_max_bytes,
            _store(owner),
            file.size,
        )


@router.get("/boards/{board_id}")
def get_board(
    board_id: str, owner: str | None = Header(default=None, alias="X-Owner-Ref")
) -> Response:
    with _not_found():
        return Response(_store(owner).get_json(board_id), media_type="application/json")


@router.get("/boards/{board_id}/download")
def download_board(
    board_id: str, owner: str | None = Header(default=None, alias="X-Owner-Ref")
) -> FileResponse:
    with _not_found():
        path, filename = _store(owner).original(board_id)
        return FileResponse(path, filename=filename, media_type="application/octet-stream")


@router.patch("/boards/{board_id}")
def update_board(
    board_id: str,
    update: BoardUpdate,
    owner: str | None = Header(default=None, alias="X-Owner-Ref"),
) -> dict:
    changes = update.model_dump(exclude_none=True)
    if "title" in changes:
        changes["title"] = changes["title"].strip()
        if not changes["title"]:
            raise HTTPException(422, "Der Name darf nicht leer sein.")
    with _not_found():
        return _store(owner).update(board_id, changes)


@router.delete("/boards/{board_id}", status_code=204)
def delete_board(
    board_id: str, owner: str | None = Header(default=None, alias="X-Owner-Ref")
) -> None:
    with _not_found():
        _store(owner).delete(board_id)


@router.get("/boards/{board_id}/worklist")
def get_worklist(
    board_id: str, owner: str | None = Header(default=None, alias="X-Owner-Ref")
) -> dict:
    with _not_found():
        return {"items": _store(owner).get_worklist(board_id)}


@router.put("/boards/{board_id}/worklist")
def put_worklist(
    board_id: str,
    worklist: Worklist,
    owner: str | None = Header(default=None, alias="X-Owner-Ref"),
) -> dict:
    items = [item.model_dump() for item in worklist.items]
    with _not_found():
        return {"items": _store(owner).set_worklist(board_id, items)}
