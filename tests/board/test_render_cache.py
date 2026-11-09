"""/render serves pre-encoded bytes; outline chaining stays order-stable."""

from __future__ import annotations

import gzip
import json
import os
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from api import config as config_mod
from api.board import render_store
from api.board import router as board_router
from api.board.byte_cache import ByteCache
from api.board.render import _trace_closed_paths

FIXTURE = Path(__file__).parent / "fixtures" / "minimal.brd"
MM = 1 / 0.0254  # the outline code converts mils to mm


def _board(*segments):
    point = lambda x, y: SimpleNamespace(x=x * MM, y=y * MM)  # noqa: E731
    return SimpleNamespace(
        arcs=[],
        traces=[
            SimpleNamespace(layer=28, a=point(*a), b=point(*b)) for a, b in segments
        ],
    )


def test_chaining_prefers_earliest_edge_at_a_junction():
    # Two edges leave (1, 0); the original linear scan took the first listed.
    board = _board(
        ((0, 0), (1, 0)),
        ((1, 0), (1, 1)),
        ((1, 0), (5, 5)),
        ((1, 1), (0, 1)),
        ((0, 1), (0, 0)),
    )
    assert _trace_closed_paths(board, 0.01) == [[(0, 0), (1, 0), (1, 1), (0, 1)]]


def test_chaining_matches_across_grid_cells_and_reversed_edges():
    # 0.0199 and 0.0201 straddle a 0.02 cell boundary but are within tolerance.
    board = _board(
        ((0, 0.0199), (1, 0)),
        ((1, 1), (1, 0)),  # reversed
        ((1, 1), (0, 0.0201)),
    )
    paths = _trace_closed_paths(board, 0.01)
    assert len(paths) == 1
    assert [round(y) for _, y in paths[0]] == [0, 0, 1]


def test_chaining_scales_to_large_outlines():
    count = 20000
    board = _board(
        *(((i, 0), (i + 1, 0)) for i in range(count)),
        ((count, 0), (count, 1)),
        ((count, 1), (0, 1)),
        ((0, 1), (0, 0)),
    )
    assert len(_trace_closed_paths(board, 0.01)[0]) == count + 3


@pytest.fixture
def seeded(tmp_path, monkeypatch):
    monkeypatch.setattr(config_mod, "_settings", None)
    monkeypatch.setenv("MEMORY_ROOT", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    uploads = tmp_path / "board-x" / "uploads"
    uploads.mkdir(parents=True)
    shutil.copyfile(FIXTURE, uploads / "20260101T000000Z-boardview-minimal.brd")
    monkeypatch.setattr(board_router, "_render_cache", ByteCache(1 << 24, 8))
    yield "board-x"
    monkeypatch.setattr(config_mod, "_settings", None)


def _count_parses(monkeypatch):
    calls = []
    original = board_router.parser_for

    def counting(path):
        calls.append(path)
        return original(path)

    monkeypatch.setattr(board_router, "parser_for", counting)
    return calls


def test_render_gzip_and_plain_share_one_parse(client, seeded, monkeypatch):
    calls = _count_parses(monkeypatch)
    url = f"/api/board/render?slug={seeded}"
    zipped = client.get(url, headers={"Accept-Encoding": "gzip"})
    plain = client.get(url, headers={"Accept-Encoding": "identity"})
    again = client.get(url, headers={"Accept-Encoding": "gzip"})
    assert zipped.headers["content-encoding"] == "gzip"
    assert "content-encoding" not in plain.headers
    assert zipped.json() == plain.json() == again.json()
    assert "board_width" in plain.json()
    assert len(calls) == 1


def test_render_requests_plain_body_behind_front_door(client, seeded, monkeypatch):
    # Asserts the encoding requested: the test app itself has GZipMiddleware,
    # which the hosted deployment (service token set) does not install.
    monkeypatch.setattr(board_router, "render_gzip_enabled", lambda: False)
    original = board_router.encode_render
    requested = []

    def spy(path, mtime, *, gzipped=False):
        requested.append(gzipped)
        return original(path, mtime, gzipped=gzipped)

    monkeypatch.setattr(board_router, "encode_render", spy)
    response = client.get(
        f"/api/board/render?slug={seeded}", headers={"Accept-Encoding": "gzip"}
    )
    assert response.status_code == 200
    assert requested == [False]


def test_encode_render_gzip_decodes_to_json(seeded, tmp_path):
    path = next((tmp_path / seeded / "uploads").iterdir())
    body = board_router.encode_render(path, 1.0, gzipped=True)
    assert json.loads(gzip.decompress(body))["board_width"] is not None


def test_concurrent_misses_build_once():
    cache = ByteCache(1024, 4)
    release = threading.Event()
    calls = []

    def build():
        calls.append(1)
        assert release.wait(5)
        return b"value"

    with ThreadPoolExecutor(max_workers=4) as pool:
        requests = [pool.submit(cache.get_or_build, "key", build) for _ in range(4)]
        release.set()
        assert {request.result(timeout=5) for request in requests} == {b"value"}
    assert len(calls) == 1


def _board_path(seeded, tmp_path):
    return next((tmp_path / seeded / "uploads").iterdir())


def _restart(monkeypatch):
    monkeypatch.setattr(board_router, "_render_cache", ByteCache(1 << 24, 8))


def _stored(tmp_path):
    return list((tmp_path / "_render_cache").glob("*/*.json.gz"))


def test_restart_serves_from_disk_without_parsing(client, seeded, tmp_path, monkeypatch):
    calls = _count_parses(monkeypatch)
    url = f"/api/board/render?slug={seeded}"
    first = client.get(url, headers={"Accept-Encoding": "gzip"})
    assert len(_stored(tmp_path)) == 1
    _restart(monkeypatch)
    second = client.get(url, headers={"Accept-Encoding": "identity"})
    assert second.json() == first.json()
    assert len(calls) == 1


def test_changed_content_is_reparsed(seeded, tmp_path, monkeypatch):
    calls = _count_parses(monkeypatch)
    path = _board_path(seeded, tmp_path)
    board_router.encode_render(path, path.stat().st_mtime)
    _restart(monkeypatch)
    with path.open("a") as handle:
        handle.write("\n")
    board_router.encode_render(path, path.stat().st_mtime)
    assert len(calls) == 2


def test_code_change_invalidates_and_removes_old_entries(seeded, tmp_path, monkeypatch):
    calls = _count_parses(monkeypatch)
    path = _board_path(seeded, tmp_path)
    board_router.encode_render(path, path.stat().st_mtime)
    old_version = _stored(tmp_path)[0].parent.name
    _restart(monkeypatch)
    monkeypatch.setattr(render_store, "_code_version", lambda: "new-version")
    board_router.encode_render(path, path.stat().st_mtime)
    assert len(calls) == 2
    assert [entry.parent.name for entry in _stored(tmp_path)] == ["new-version"]
    assert old_version != "new-version"


@pytest.mark.parametrize("suffix", [".pcb", ".fz", ".asc", ".FZ"])
def test_sensitive_or_multi_file_formats_are_not_persisted(tmp_path, suffix):
    path = tmp_path / f"board{suffix}"
    path.write_bytes(b"data")
    assert render_store.entry_for(path) is None


def test_corrupt_entry_is_discarded_and_reparsed(seeded, tmp_path, monkeypatch):
    calls = _count_parses(monkeypatch)
    path = _board_path(seeded, tmp_path)
    board_router.encode_render(path, path.stat().st_mtime)
    entry = _stored(tmp_path)[0]
    entry.write_bytes(entry.read_bytes()[:20])
    _restart(monkeypatch)
    body = board_router.encode_render(path, path.stat().st_mtime, gzipped=True)
    assert "board_width" in json.loads(gzip.decompress(body))
    assert len(calls) == 2


def test_unwritable_store_still_renders(client, seeded, tmp_path):
    (tmp_path / "_render_cache").write_text("not a directory")
    response = client.get(f"/api/board/render?slug={seeded}")
    assert response.status_code == 200
    assert "board_width" in response.json()


def test_store_keeps_most_recent_entries(tmp_path, monkeypatch):
    monkeypatch.setattr(render_store, "_MAX_FILES", 2)
    directory = tmp_path / "version"
    for index in range(4):
        render_store.save(directory / f"{index}.json.gz", gzip.compress(b"{}"))
        os.utime(directory / f"{index}.json.gz", (index, index))
    render_store.save(directory / "4.json.gz", gzip.compress(b"{}"))
    assert sorted(file.name for file in directory.iterdir()) == ["3.json.gz", "4.json.gz"]


def test_cache_directory_is_not_listed_as_a_pack(client, seeded):
    assert client.get(f"/api/board/render?slug={seeded}").status_code == 200
    slugs = [pack["device_slug"] for pack in client.get("/pipeline/packs").json()]
    assert "_render_cache" not in slugs
