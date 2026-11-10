"""Searchable, paginated catalog of local xzz_downloads files.

Only filenames and filesystem metadata are indexed. Large source files remain
untouched; parsing and library import happen on an explicit click. The local
collection is never exposed to gateway tenants via X-Owner-Ref.
"""

from __future__ import annotations

import asyncio
import contextlib
import fcntl
import hashlib
import os
import re
import sqlite3
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import FileResponse

from api.board.board_identity import is_global_number, normalize_board_number, parse_identity
from api.board.catalog_folders import build_folders, folder_listing, grouped_files
from api.board.http_errors import import_errors
from api.board.imports import import_library_path
from api.board.library_store import LibraryStore
from api.board.parser.base import _REGISTRY
from api.config import get_settings
from api.errors import CodedHTTPException

router = APIRouter(prefix="/api/library/source", tags=["pcb-library"])
_DOCUMENTS = {".pdf"}
_ARCHIVES = {".zip", ".rar", ".7z"}
_OTHER = {".bin", ".obdata", ".faz"}
# Bump when the files/devices shape changes: an older database is rebuilt.
_SCHEMA_VERSION = "3"
_FILE_COLUMNS = (
    "id, name, path, directory, stem, category, extension, kind, size_bytes, modified_ns, "
    "search_text, board_number, brand, model"
)
_DOCUMENT_CAP = 50
# Above either bound a folder is a bin of unrelated boards, so being in the same
# folder proves nothing and a PDF has to relate to the board by number or name.
_MIXED_FOLDER_NUMBERS = 6
_MIXED_FOLDER_FILES = 120
_MIN_NAME_SIMILARITY = 0.5
_TIER_BASE = {"folder": 0.7, "board_number": 0.4, "name": 0.1}
_TIER_SPAN = 0.29
_SCHEMATIC_HINT = re.compile(r"schemat|(?<![a-z])sch(?![a-z])|circuit|原理图|电路图", re.IGNORECASE)
_STEM_NOISE = frozenset(
    """
    boardview schematic schematics sch pcb layer yidiantong board mainboard main final view rev
    ver version sub diode value image location map rte top bottom dvt pvt evt svt tvw brd pdf
    apple asus dell lenovo acer msi gigabyte samsung huawei xiaomi iphone ipad macbook pro plus
    max ultra lite new old repair case gen intel amd uma dis discrete nvidia for and the
    """.split()
)


def _source(owner: str | None) -> Path:
    if owner is not None:
        raise CodedHTTPException(
            404, "local_collection_unavailable", "Local collection not available."
        )
    configured = get_settings().pcb_library_source_root
    if not configured or not (root := Path(configured).resolve()).is_dir():
        raise CodedHTTPException(
            404, "source_folder_unavailable", "The collection folder is not available."
        )
    return root


def _cache_root() -> Path:
    root = Path(get_settings().memory_root) / "_pcb_catalog"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _kind(extension: str) -> str | None:
    if extension in _REGISTRY:
        return "board"
    if extension in _DOCUMENTS:
        return "pdf"
    if extension in _ARCHIVES:
        return "archive"
    if extension in _OTHER:
        return "other"
    return None


_INSERT_FILE = f"INSERT INTO files ({_FILE_COLUMNS}) VALUES ({','.join('?' * 14)})"


def _index(root: Path, *, force: bool = False) -> Path:
    cache = _cache_root()
    database = cache / "catalog.sqlite3"
    with (cache / ".lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if database.is_file() and not force:
            with contextlib.closing(sqlite3.connect(database)) as connection:
                stored = dict(connection.execute("SELECT key, value FROM metadata").fetchall())
            if (
                stored.get("source_root") == str(root)
                and stored.get("schema_version") == _SCHEMA_VERSION
            ):
                return database
        descriptor, temporary = tempfile.mkstemp(prefix=".catalog-", suffix=".sqlite3", dir=cache)
        os.close(descriptor)
        try:
            with contextlib.closing(sqlite3.connect(temporary)) as connection:
                connection.executescript("""
                    CREATE TABLE files (
                        id TEXT PRIMARY KEY, name TEXT, path TEXT, directory TEXT, stem TEXT,
                        category TEXT, extension TEXT, kind TEXT, size_bytes INTEGER,
                        modified_ns INTEGER, search_text TEXT,
                        board_number TEXT, brand TEXT, model TEXT
                    );
                    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
                """)
                batch = []
                for directory, folders, names in os.walk(root, followlinks=False):
                    folders[:] = sorted(name for name in folders if not name.startswith("."))
                    for name in names:
                        path = Path(directory) / name
                        extension = path.suffix.lower()
                        kind = _kind(extension)
                        if kind is None or path.is_symlink():
                            continue
                        try:
                            stat = path.stat()
                        except OSError:
                            continue
                        relative = path.relative_to(root).as_posix()
                        identity = parse_identity(relative)
                        number = identity["board_number"]
                        batch.append(
                            (
                                hashlib.sha256(relative.encode()).hexdigest(),
                                name,
                                relative,
                                relative.rsplit("/", 1)[0] if "/" in relative else "",
                                path.stem.casefold(),
                                relative.split("/")[0] if "/" in relative else "Sonstige",
                                extension,
                                kind,
                                stat.st_size,
                                stat.st_mtime_ns,
                                f"{relative} {number}".casefold()
                                if number
                                else relative.casefold(),
                                number,
                                identity["brand"],
                                identity["model"],
                            )
                        )
                        if len(batch) >= 2000:
                            connection.executemany(_INSERT_FILE, batch)
                            batch.clear()
                connection.executemany(_INSERT_FILE, batch)
                connection.executescript("""
                    CREATE INDEX files_kind ON files(kind);
                    CREATE INDEX files_category ON files(category);
                    CREATE INDEX files_name ON files(name COLLATE NOCASE, path);
                    CREATE INDEX files_directory ON files(directory);
                    CREATE INDEX files_board_number ON files(board_number);
                    CREATE TABLE devices AS
                        SELECT brand, model, board_number,
                               sum(kind = 'board') AS board_count,
                               sum(kind = 'pdf') AS pdf_count,
                               lower(coalesce(brand, '') || ' ' || coalesce(model, '') || ' '
                                     || coalesce(board_number, '')) AS search_text
                        FROM files
                        WHERE kind IN ('board', 'pdf')
                          AND (board_number IS NOT NULL OR model IS NOT NULL)
                        GROUP BY brand, model, board_number
                        ORDER BY brand IS NULL, brand COLLATE NOCASE,
                                 model IS NULL, model COLLATE NOCASE, board_number;
                """)
                build_folders(connection)
                connection.executemany(
                    "INSERT INTO metadata VALUES (?,?)",
                    [
                        ("source_root", str(root)),
                        ("schema_version", _SCHEMA_VERSION),
                        ("indexed_at", datetime.now(UTC).isoformat()),
                    ],
                )
                connection.commit()
            os.replace(temporary, database)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return database


@contextlib.contextmanager
def _connection(root: Path):
    connection = sqlite3.connect(_index(root))
    connection.row_factory = sqlite3.Row
    try:
        yield connection
    finally:
        connection.close()


def _file(root: Path, file_id: str) -> tuple[dict, Path]:
    with _connection(root) as connection:
        row = connection.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
    if row is None:
        raise CodedHTTPException(404, "file_not_found", "File not found.")
    path = (root / row["path"]).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise CodedHTTPException(
            404, "file_gone", "The file no longer exists. Please refresh the catalog."
        )
    return dict(row), path


def _like(token: str) -> str:
    """Contains-pattern where %, _ and backslash stay literal (use ESCAPE '\\')."""
    return "%" + token.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _stem_tokens(stem: str) -> set[str]:
    tokens = (token for token in re.split(r"[^0-9a-z]+", stem.casefold()) if len(token) >= 3)
    return {
        token
        for token in tokens
        if token not in _STEM_NOISE and not (token.isdigit() and len(token) > 6)
    }


def _is_distinctive(token: str) -> bool:
    return len(token) >= 6 or (len(token) >= 4 and any(c.isdigit() for c in token))


def _similarity(reference: set[str], tokens: set[str]) -> float:
    shared = reference & tokens
    if not any(_is_distinctive(token) for token in shared):
        return 0.0
    return len(shared) / min(len(reference), len(tokens))


def _conflicts(row: sqlite3.Row, board_number: str | None, brand: str | None) -> bool:
    if board_number and row["board_number"] and row["board_number"] != board_number:
        return True
    return bool(brand and row["brand"] and row["brand"] != brand)


def _rank_documents(
    connection: sqlite3.Connection,
    *,
    board_number: str | None,
    brand: str | None,
    stem: str,
    directory: str | None = None,
    exclude_id: str | None = None,
    limit: int = _DOCUMENT_CAP,
) -> list[dict]:
    """PDFs related to a board: same folder, then same number, then similar name."""
    limit = min(limit, _DOCUMENT_CAP)
    reference = _stem_tokens(stem)
    columns = "id, name, path, size_bytes, stem, board_number, brand"
    seen = {exclude_id}
    results: list[dict] = []

    def collect(match: str, scored: list[tuple[float, sqlite3.Row]]) -> None:
        tier = sorted(scored, key=lambda item: (-item[0], item[1]["name"].casefold()))
        for relevance, row in tier[: limit - len(results)]:
            seen.add(row["id"])
            results.append(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "path": row["path"],
                    "size_bytes": row["size_bytes"],
                    "match": match,
                    "score": round(_TIER_BASE[match] + _TIER_SPAN * relevance, 3),
                }
            )

    def hint(row: sqlite3.Row) -> float:
        return 1.0 if _SCHEMATIC_HINT.search(row["name"]) else 0.0

    if directory is not None:
        numbers, files = connection.execute(
            "SELECT count(DISTINCT board_number), count(*) FROM files "
            "WHERE directory = ? AND kind IN ('board', 'pdf')",
            (directory,),
        ).fetchone()
        mixed = numbers >= _MIXED_FOLDER_NUMBERS or files >= _MIXED_FOLDER_FILES
        scored = []
        for row in connection.execute(
            f"SELECT {columns} FROM files WHERE kind = 'pdf' AND directory = ?", (directory,)
        ):
            if row["id"] in seen:
                continue
            similarity = _similarity(reference, _stem_tokens(row["stem"]))
            same_number = board_number is not None and row["board_number"] == board_number
            if mixed and (
                _conflicts(row, board_number, None)
                or not (same_number or similarity >= _MIN_NAME_SIMILARITY)
            ):
                continue
            scored.append((0.7 * max(float(same_number), similarity) + 0.3 * hint(row), row))
        collect("folder", scored)

    if board_number and len(results) < limit:
        clauses = "kind = 'pdf' AND board_number = ?"
        params: list[str] = [board_number]
        if brand and not is_global_number(board_number):
            clauses += " AND (brand = ? OR brand IS NULL)"
            params.append(brand)
        scored = []
        for row in connection.execute(
            f"SELECT {columns} FROM files WHERE {clauses} LIMIT 2000", params
        ):
            if row["id"] not in seen:
                similarity = _similarity(reference, _stem_tokens(row["stem"]))
                scored.append((0.6 * hint(row) + 0.4 * similarity, row))
        collect("board_number", scored)

    if len(results) < limit:
        # Longest distinctive tokens select candidates; the full token set scores them.
        needles = sorted(filter(_is_distinctive, reference), key=len, reverse=True)[:2]
        scored = {}
        for needle in needles:
            for row in connection.execute(
                f"SELECT {columns} FROM files WHERE kind = 'pdf' AND stem LIKE ? ESCAPE '\\' "
                "LIMIT 500",
                (_like(needle),),
            ):
                if row["id"] in seen or _conflicts(row, board_number, brand):
                    continue
                similarity = _similarity(reference, _stem_tokens(row["stem"]))
                if similarity >= _MIN_NAME_SIMILARITY:
                    scored[row["id"]] = (0.7 * similarity + 0.3 * hint(row), row)
        collect("name", list(scored.values()))
    return results


def documents_for_stem(root: Path, filename: str, limit: int = _DOCUMENT_CAP) -> list[dict]:
    """Ranked PDFs for a board known only by file name (no catalog entry).

    Matches on the board number parsed from the name, then on a similar stem.
    Items have the shape of ``GET /files/{file_id}/documents``.
    """
    name = Path(filename).name
    identity = parse_identity(name)
    with _connection(root) as connection:
        return _rank_documents(
            connection,
            board_number=identity["board_number"],
            brand=identity["brand"],
            stem=Path(name).stem,
            limit=limit,
        )


def _info(root: Path) -> dict:
    with _connection(root) as connection:
        total, size = connection.execute(
            "SELECT count(*), coalesce(sum(size_bytes), 0) FROM files"
        ).fetchone()
        kinds = dict(
            connection.execute("SELECT kind, count(*) FROM files GROUP BY kind").fetchall()
        )
        categories = [
            dict(row)
            for row in connection.execute(
                "SELECT category AS name, count(*) AS count FROM files GROUP BY category ORDER BY category"
            )
        ]
        indexed_at = connection.execute(
            "SELECT value FROM metadata WHERE key = 'indexed_at'"
        ).fetchone()[0]
    return {
        "available": True,
        "name": root.name,
        "total": total,
        "size_bytes": size,
        "kinds": kinds,
        "categories": categories,
        "indexed_at": indexed_at,
    }


@router.get("")
def source_info(owner: str | None = Header(default=None, alias="X-Owner-Ref")) -> dict:
    try:
        root = _source(owner)
    except HTTPException:
        return {
            "available": False,
            "name": "xzz_downloads",
            "total": 0,
            "categories": [],
            "kinds": {},
        }
    return _info(root)


@router.post("/refresh")
def refresh_source(owner: str | None = Header(default=None, alias="X-Owner-Ref")) -> dict:
    root = _source(owner)
    _index(root, force=True)
    return _info(root)


@router.get("/files")
def list_source_files(
    q: str = Query(default="", max_length=300),
    kind: str = Query(default="board", pattern="^(all|board|pdf|archive|other)$"),
    category: str = Query(default="", max_length=200),
    folder: str | None = Query(default=None, max_length=1000),
    recursive: bool = False,
    group: bool = False,
    board_number: str = Query(default="", max_length=100),
    sort: str = Query(default="name", pattern="^(name|recent|size)$"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=60, ge=1, le=120),
    owner: str | None = Header(default=None, alias="X-Owner-Ref"),
) -> dict:
    root = _source(owner)
    clauses, params = [], []
    if kind != "all":
        clauses.append("kind = ?")
        params.append(kind)
    if category:
        clauses.append("category = ?")
        params.append(category)
    if folder is not None and not (recursive and not folder):
        if recursive:
            # A range on the index: "0" is the character right after "/".
            clauses.append("(directory = ? OR (directory >= ? AND directory < ?))")
            params.extend([folder, f"{folder}/", f"{folder}0"])
        else:
            clauses.append("directory = ?")
            params.append(folder)
    if board_number.strip():
        clauses.append("board_number = ?")
        params.append(normalize_board_number(board_number))
    # Each search word matches anywhere in the relative path, including brand
    # and model folders, or in the parsed board number.
    for token in q.casefold().split():
        clauses.append("search_text LIKE ? ESCAPE '\\'")
        params.append(_like(token))
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    order = {
        "name": "name COLLATE NOCASE, path",
        "recent": "modified_ns DESC, path",
        "size": "size_bytes DESC, path",
    }[sort]
    columns = (
        "id, name, path, category, extension, kind, size_bytes, modified_ns, "
        "board_number, brand, model"
    )
    with _connection(root) as connection:
        if group and folder is not None and not recursive:
            return grouped_files(connection, columns, where, params, sort, offset, limit)
        total = connection.execute("SELECT count(*) FROM files" + where, params).fetchone()[0]
        rows = connection.execute(
            f"SELECT {columns} FROM files"
            + where
            + " ORDER BY "
            + order
            + " LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
    return {"items": [dict(row) for row in rows], "total": total, "offset": offset, "limit": limit}


@router.get("/devices")
def list_source_devices(
    q: str = Query(default="", max_length=300),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=60, ge=1, le=120),
    owner: str | None = Header(default=None, alias="X-Owner-Ref"),
) -> dict:
    root = _source(owner)
    tokens = q.casefold().split()
    where = " AND ".join(["search_text LIKE ? ESCAPE '\\'"] * len(tokens))
    where = f" WHERE {where}" if where else ""
    params = [_like(token) for token in tokens]
    with _connection(root) as connection:
        total = connection.execute("SELECT count(*) FROM devices" + where, params).fetchone()[0]
        # rowid order is the brand/model/number order the table was built in.
        rows = connection.execute(
            "SELECT brand, model, board_number, board_count, pdf_count FROM devices"
            + where
            + " ORDER BY rowid LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
    return {"items": [dict(row) for row in rows], "total": total, "offset": offset, "limit": limit}


@router.get("/folders")
def list_source_folders(
    path: str = Query(default="", max_length=1000),
    kind: str = Query(default="board", pattern="^(all|board|pdf|archive|other)$"),
    owner: str | None = Header(default=None, alias="X-Owner-Ref"),
) -> dict:
    root = _source(owner)
    with _connection(root) as connection:
        listing = folder_listing(connection, path, root.name, kind)
    if listing is None:
        raise CodedHTTPException(404, "folder_not_found", "Folder not found.")
    return listing


@router.get("/documents")
def list_documents_for_filename(
    filename: str = Query(min_length=1, max_length=500),
    owner: str | None = Header(default=None, alias="X-Owner-Ref"),
) -> dict:
    """PDFs for an imported board, which only knows its original file name."""
    items = documents_for_stem(_source(owner), filename)
    return {"items": items, "total": len(items)}


@router.get("/files/{file_id}/documents")
def list_source_documents(
    file_id: str, owner: str | None = Header(default=None, alias="X-Owner-Ref")
) -> dict:
    root = _source(owner)
    record, _path = _file(root, file_id)
    with _connection(root) as connection:
        items = _rank_documents(
            connection,
            board_number=record["board_number"],
            brand=record["brand"],
            stem=record["stem"],
            directory=record["directory"],
            exclude_id=file_id,
        )
    return {"items": items, "total": len(items)}


@router.post("/files/{file_id}/open")
async def open_source_file(
    file_id: str, owner: str | None = Header(default=None, alias="X-Owner-Ref")
) -> dict:
    root = _source(owner)
    record, path = await asyncio.to_thread(_file, root, file_id)
    if record["kind"] != "board":
        raise CodedHTTPException(
            415,
            "not_a_boardview",
            "This file is not a supported boardview. Download it or open it as a PDF.",
        )
    # Import just the chosen file, reusing deduplication and the upload limits.
    with import_errors():
        return await asyncio.to_thread(
            import_library_path,
            path,
            get_settings().board_upload_max_bytes,
            LibraryStore(Path(get_settings().memory_root)),
        )


@router.get("/files/{file_id}/download")
def download_source_file(
    file_id: str,
    inline: bool = False,
    owner: str | None = Header(default=None, alias="X-Owner-Ref"),
) -> FileResponse:
    root = _source(owner)
    record, path = _file(root, file_id)
    pdf = record["kind"] == "pdf"
    return FileResponse(
        path,
        filename=path.name,
        media_type="application/pdf" if pdf else "application/octet-stream",
        content_disposition_type="inline" if inline and pdf else "attachment",
    )
