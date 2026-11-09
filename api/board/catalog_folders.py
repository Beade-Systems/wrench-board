"""Folder tree of the source catalog: per-folder counts and display names."""

from __future__ import annotations

import re
import sqlite3
from collections import defaultdict
from collections.abc import Iterable

# Curators number folders to fix their order ("1 Laptop", "10 BIOS", "2.MB BIOS").
_NUMBER_PREFIX = re.compile(r"^\d{1,2}[ .]+(?=\S)")
_DIGITS = re.compile(r"(\d+)")
# Below this share a number belongs to the name ("0 ACER Repair Case" beside "Aspire").
_NUMBERED_SHARE = 0.6
_KIND_COLUMNS = {"board": "boards", "pdf": "pdfs", "archive": "archives", "other": "other"}
_COLUMNS = "path, name, label, boards, pdfs, archives, other, size_bytes, subfolders"


def display_names(names: Iterable[str]) -> dict[str, str]:
    """Sibling names without their sort numbers, when the folder is numbered as a whole."""
    siblings = list(names)
    stripped = {name: _NUMBER_PREFIX.sub("", name) for name in siblings}
    numbered = sum(stripped[name] != name for name in siblings)
    if len(siblings) < 2 or numbered / len(siblings) < _NUMBERED_SHARE:
        return {name: name for name in siblings}
    return stripped


def natural_key(name: str) -> list[int | str]:
    """Sort key that orders "2 PC" before "10 BIOS"."""
    return [int(part) if part.isdigit() else part.casefold() for part in _DIGITS.split(name)]


def build_folders(connection: sqlite3.Connection) -> None:
    """Create the `folders` table from the already filled `files` table."""
    totals: defaultdict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0, 0])
    positions = {kind: index for index, kind in enumerate(_KIND_COLUMNS)}
    rows = connection.execute(
        "SELECT directory, kind, count(*), sum(size_bytes) FROM files GROUP BY directory, kind"
    )
    for directory, kind, count, size in rows:
        parts = directory.split("/") if directory else []
        for depth in range(len(parts) + 1):
            entry = totals["/".join(parts[:depth])]
            entry[positions[kind]] += count
            entry[4] += size

    children: defaultdict[str, list[str]] = defaultdict(list)
    for path in totals:
        if path:
            children[path.rpartition("/")[0]].append(path)

    connection.execute(
        """
        CREATE TABLE folders (
            path TEXT PRIMARY KEY, parent TEXT, name TEXT, label TEXT, position INTEGER,
            boards INTEGER, pdfs INTEGER, archives INTEGER, other INTEGER,
            size_bytes INTEGER, subfolders INTEGER
        )
        """
    )
    records = [(path := "", None, "", "", 0, *totals[path], len(children[path]))]
    for parent, paths in children.items():
        names = {path: path.rpartition("/")[2] for path in paths}
        labels = display_names(names.values())
        ordered = sorted(paths, key=lambda path: natural_key(names[path]))
        records.extend(
            (path, parent, names[path], labels[names[path]], position, *totals[path],
             len(children.get(path, ())))
            for position, path in enumerate(ordered)
        )
    connection.executemany("INSERT INTO folders VALUES (?,?,?,?,?,?,?,?,?,?,?)", records)
    connection.execute("CREATE INDEX folders_parent ON folders(parent, position)")


def folder_listing(
    connection: sqlite3.Connection, path: str, root_name: str, kind: str
) -> dict | None:
    """One folder with its breadcrumbs and subfolders; None when it does not exist."""
    current = connection.execute(f"SELECT {_COLUMNS} FROM folders WHERE path = ?", (path,)).fetchone()
    if current is None:
        return None
    parts = path.split("/") if path else []
    ancestors = ["/".join(parts[: depth + 1]) for depth in range(len(parts))]
    marks = ",".join("?" * len(ancestors))
    labels = dict(
        connection.execute(f"SELECT path, label FROM folders WHERE path IN ({marks})", ancestors)
    )
    column = _KIND_COLUMNS.get(kind)
    only_kind = f" AND {column} > 0" if column else ""
    folders = connection.execute(
        f"SELECT {_COLUMNS} FROM folders WHERE parent = ?{only_kind} ORDER BY position", (path,)
    )
    return {
        "path": path,
        "label": labels.get(path, root_name),
        "breadcrumbs": [
            {"path": "", "label": root_name},
            *({"path": item, "label": labels[item]} for item in ancestors),
        ],
        "counts": dict(current),
        "folders": [dict(row) for row in folders],
    }
