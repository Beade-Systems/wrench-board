"""Owner-scoped, atomic file storage for the PCB library; no HTTP dependencies."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shutil
import tempfile
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

_BOARD_ID = re.compile(r"^[a-f0-9]{64}$")


class LibraryBoardNotFound(LookupError):
    pass


class LibraryStore:
    def __init__(self, memory_root: Path, owner: str | None = None):
        scope = "local" if owner is None else hashlib.sha256(owner.encode()).hexdigest()
        self.root = Path(memory_root) / "_pcb_library" / scope

    @contextmanager
    def _locked(self):
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / ".lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def _directory(self, board_id: str) -> Path:
        if not _BOARD_ID.fullmatch(board_id):
            raise LibraryBoardNotFound(board_id)
        directory = self.root / board_id
        if not (directory / "metadata.json").is_file():
            raise LibraryBoardNotFound(board_id)
        return directory

    @staticmethod
    def _metadata(directory: Path) -> dict:
        return json.loads((directory / "metadata.json").read_text(encoding="utf-8"))

    def find(self, board_id: str) -> dict | None:
        with self._locked():
            try:
                return self._metadata(self._directory(board_id))
            except LibraryBoardNotFound:
                return None

    def list(self) -> list[dict]:
        with self._locked():
            boards = [self._metadata(path.parent) for path in self.root.glob("*/metadata.json")]
        return sorted(boards, key=lambda board: board["imported_at"], reverse=True)

    def get(self, board_id: str) -> dict:
        with self._locked():
            directory = self._directory(board_id)
            return {
                "metadata": self._metadata(directory),
                "board": json.loads((directory / "board.json").read_text(encoding="utf-8")),
            }

    def get_json(self, board_id: str) -> bytes:
        """`get` as encoded JSON, spliced from the stored files without decoding."""
        with self._locked():
            directory = self._directory(board_id)
            return b"".join(
                (
                    b'{"metadata":',
                    (directory / "metadata.json").read_bytes(),
                    b',"board":',
                    (directory / "board.json").read_bytes(),
                    b"}",
                )
            )

    def original(self, board_id: str) -> tuple[Path, str]:
        with self._locked():
            directory = self._directory(board_id)
            return directory / "original", self._metadata(directory)["filename"]

    def update(self, board_id: str, changes: dict) -> dict:
        with self._locked():
            directory = self._directory(board_id)
            metadata = self._metadata(directory) | changes
            temporary = directory / ".metadata.json"
            temporary.write_text(json.dumps(metadata), encoding="utf-8")
            os.replace(temporary, directory / "metadata.json")
            return metadata

    def get_worklist(self, board_id: str) -> list[dict]:
        with self._locked():
            path = self._directory(board_id) / "worklist.json"
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return []

    def set_worklist(self, board_id: str, items: list[dict]) -> list[dict]:
        with self._locked():
            directory = self._directory(board_id)
            temporary = directory / ".worklist.json"
            temporary.write_text(json.dumps(items), encoding="utf-8")
            os.replace(temporary, directory / "worklist.json")
            return items

    def delete(self, board_id: str) -> None:
        with self._locked():
            shutil.rmtree(self._directory(board_id))

    def save(self, board: dict, filename: str, data: bytes) -> dict:
        board_id = board["file_hash"].removeprefix("sha256:")
        filename = filename.replace("\\", "/").split("/")[-1]
        with self._locked():
            destination = self.root / board_id
            if destination.exists():
                return {"board": self._metadata(destination), "duplicate": True}
            metadata = {
                "id": board_id,
                "title": Path(filename).stem,
                "filename": filename,
                "format": board["source_format"],
                "imported_at": datetime.now(UTC).isoformat(),
                "parts_count": len(board["parts"]),
                "pins_count": len(board["pins"]),
                "nets_count": len(board["nets"]),
                "favorite": False,
                "notes": "",
                "size_bytes": len(data),
            }
            with tempfile.TemporaryDirectory(prefix=".import-", dir=self.root) as temporary:
                staging = Path(temporary) / "board"
                staging.mkdir()
                (staging / "original").write_bytes(data)
                (staging / "board.json").write_text(json.dumps(board), encoding="utf-8")
                (staging / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
                staging.rename(destination)
            return {"board": metadata, "duplicate": False}
