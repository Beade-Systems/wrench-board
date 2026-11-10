"""Shared board upload service, independent of HTTP and request event loops.

The bounded cache stores immutable JSON and coalesces concurrent duplicate
imports per owner. Failed imports are never cached. Encrypted formats bypass
this cache so their currently configured decryption keys are always checked.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from api.board.byte_cache import ByteCache
from api.board.library_store import LibraryStore
from api.board.parser.base import BoardParser, parser_for

_CHUNK = 1 << 20
ENCRYPTED_SUFFIXES = {".fz", ".pcb"}


class UploadRejected(ValueError):
    def __init__(self, status: int, detail: dict):
        super().__init__(detail["message"])
        self.status = status
        self.detail = detail


def _read_upload(source: BinaryIO, max_bytes: int, declared_size: int | None) -> bytes:
    def too_large():
        return UploadRejected(
            413,
            {
                "detail": "file-too-large",
                "max_bytes": max_bytes,
                "message": f"upload exceeds {max_bytes} bytes",
            },
        )

    if declared_size is not None and declared_size > max_bytes:
        raise too_large()
    source.seek(0)
    chunks = []
    total = 0
    while chunk := source.read(_CHUNK):
        total += len(chunk)
        if total > max_bytes:
            raise too_large()
        chunks.append(chunk)
    if not total:
        raise UploadRejected(400, {"detail": "empty-file", "message": "uploaded file is empty"})
    return b"".join(chunks)


@dataclass(frozen=True)
class PreparedBoard:
    filename: str
    data: bytes
    file_hash: str
    parser: BoardParser


def prepare_upload(
    source: BinaryIO, filename: str, max_bytes: int, declared_size: int | None = None
) -> PreparedBoard:
    data = _read_upload(source, max_bytes, declared_size)
    file_hash = "sha256:" + hashlib.sha256(data).hexdigest()
    with tempfile.NamedTemporaryFile(suffix=Path(filename).suffix or ".brd") as temporary:
        temporary.write(data)
        temporary.flush()
        parser = parser_for(Path(temporary.name))
    return PreparedBoard(filename, data, file_hash, parser)


class BoardImportService:
    def __init__(self, max_cache_bytes: int = 32 << 20, max_entries: int = 16):
        self._get_or_build = ByteCache(max_cache_bytes, max_entries).get_or_build

    def parse(
        self,
        source: BinaryIO,
        filename: str,
        max_bytes: int,
        declared_size: int | None = None,
        owner: str | None = None,
    ) -> dict:
        prepared = prepare_upload(source, filename, max_bytes, declared_size)
        return self.parse_prepared(prepared, owner)

    def parse_json(
        self,
        source: BinaryIO,
        filename: str,
        max_bytes: int,
        declared_size: int | None = None,
        owner: str | None = None,
    ) -> bytes:
        """Same result as `parse`, already encoded for the HTTP response."""
        prepared = prepare_upload(source, filename, max_bytes, declared_size)
        return self._encoded(prepared, owner)

    def parse_prepared(self, prepared: PreparedBoard, owner: str | None = None) -> dict:
        return json.loads(self._encoded(prepared, owner))

    def _encoded(self, prepared: PreparedBoard, owner: str | None) -> bytes:
        filename, data, file_hash, parser = (
            prepared.filename,
            prepared.data,
            prepared.file_hash,
            prepared.parser,
        )
        board_id = Path(filename).stem

        def build():
            board = parser.parse(data, file_hash=file_hash, board_id=board_id).model_dump()
            del board["board_id"]
            return json.dumps(board, allow_nan=False, separators=(",", ":")).encode()

        from api.board.parser.fz import FZParser
        from api.board.parser.xzz import XZZParser

        if Path(filename).suffix.lower() in ENCRYPTED_SUFFIXES or isinstance(parser, (FZParser, XZZParser)):
            encoded = build()
        else:
            encoded = self._get_or_build((owner, type(parser), file_hash), build)
        # The cached body is name-independent; board_id follows the current upload.
        return b"".join((b'{"board_id":', json.dumps(board_id).encode(), b",", encoded[1:]))


board_import_service = BoardImportService()


def import_into_library(
    source: BinaryIO,
    filename: str,
    max_bytes: int,
    store: LibraryStore,
    declared_size: int | None = None,
) -> dict:
    prepared = prepare_upload(source, filename, max_bytes, declared_size)
    existing = store.find(prepared.file_hash.removeprefix("sha256:"))
    if existing is not None:
        return {"board": existing, "duplicate": True}
    board = board_import_service.parse_prepared(prepared, owner=str(store.root.resolve()))
    return store.save(board, prepared.filename, prepared.data)


def import_library_path(path: Path, max_bytes: int, store: LibraryStore) -> dict:
    with path.open("rb") as source:
        return import_into_library(source, path.name, max_bytes, store)
