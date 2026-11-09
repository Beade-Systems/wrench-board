"""On-disk gzip render payloads, so a restart does not re-parse every boardview.

Entries are keyed by file name + content, under a fingerprint of the parser and
render code: a code change starts a fresh directory instead of serving stale
geometry. This is a cache, so every failure degrades to a normal parse.

Not stored: encrypted formats (the decrypted board must not outlive the key)
and `.asc` (its content may come from sibling files the hash does not cover).
"""

from __future__ import annotations

import contextlib
import gzip
import hashlib
import logging
import os
import shutil
import tempfile
import zlib
from functools import lru_cache
from pathlib import Path

from api.board.imports import ENCRYPTED_SUFFIXES
from api.config import get_settings

logger = logging.getLogger("wrench_board.board.render_store")

_MAX_FILES = 128
_UNCACHEABLE_SUFFIXES = {*ENCRYPTED_SUFFIXES, ".asc"}


def _root() -> Path:
    return Path(get_settings().memory_root) / "_render_cache"


@lru_cache(maxsize=1)
def _code_version() -> str:
    board = Path(__file__).parent
    digest = hashlib.sha256()
    for file in sorted([board / "render.py", board / "model.py", *board.glob("parser/**/*.py")]):
        digest.update(file.relative_to(board).as_posix().encode())
        digest.update(file.read_bytes())
    return digest.hexdigest()[:16]


def entry_for(path: Path) -> Path | None:
    """Cache location for a boardview, or None when it must not be persisted."""
    if path.suffix.lower() in _UNCACHEABLE_SUFFIXES:
        return None
    try:
        digest = hashlib.sha256(path.name.encode() + b"\0" + path.read_bytes()).hexdigest()
    except OSError:
        return None
    return _root() / _code_version() / f"{digest}.json.gz"


def load(entry: Path | None) -> bytes | None:
    if entry is None:
        return None
    try:
        body = entry.read_bytes()
        gzip.decompress(body)  # A damaged entry must become a miss, not a bad response.
    except FileNotFoundError:
        return None
    except (OSError, EOFError, zlib.error):
        logger.warning("discarding unreadable render cache entry %s", entry.name, exc_info=True)
        with contextlib.suppress(OSError):
            entry.unlink()
        return None
    with contextlib.suppress(OSError):
        os.utime(entry)  # Recency for pruning.
    return body


def save(entry: Path | None, body: bytes) -> None:
    if entry is None:
        return
    temporary = None
    try:
        entry.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(dir=entry.parent, suffix=".tmp")
        with os.fdopen(descriptor, "wb") as output:
            output.write(body)
        os.replace(temporary, entry)
        temporary = None
        _prune(entry.parent)
    except OSError:
        logger.warning("could not persist render cache entry %s", entry.name, exc_info=True)
    finally:
        if temporary is not None:
            with contextlib.suppress(OSError):
                os.unlink(temporary)


def _prune(current: Path) -> None:
    for directory in current.parent.iterdir():
        if directory != current:
            shutil.rmtree(directory, ignore_errors=True)
    entries = sorted(current.glob("*.json.gz"), key=lambda file: file.stat().st_mtime, reverse=True)
    for stale in entries[_MAX_FILES:]:
        stale.unlink(missing_ok=True)
