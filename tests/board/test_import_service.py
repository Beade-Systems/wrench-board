"""Import validation, owner isolation and reuse of identical uploads."""

import io
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from api.board import imports
from api.board.imports import BoardImportService, UploadRejected
from api.board.parser.base import BoardParserError, InvalidBoardFile, UnsupportedFormatError

DATA = (Path(__file__).parent / "fixtures/minimal.brd").read_bytes()


@pytest.fixture
def counted(monkeypatch):
    original = imports.parser_for
    calls = []

    class Parser:
        def __init__(self, real):
            self.real = real

        def parse(self, data, **kwargs):
            calls.append(kwargs["board_id"])
            return self.real.parse(data, **kwargs)

    monkeypatch.setattr(imports, "parser_for", lambda path: Parser(original(path)))
    return calls


def load(service, data=DATA, name="board.brd", owner=None, limit=1 << 20, declared=None):
    return service.parse(io.BytesIO(data), name, limit, declared, owner)


def test_duplicate_reuses_parse_but_preserves_current_name_and_owner(counted):
    service = BoardImportService()
    first = load(service, owner="a")
    second = load(service, name="copy.brd", owner="a")
    assert first["file_hash"] == second["file_hash"]
    assert second["board_id"] == "copy"
    assert counted == ["board"]
    first["parts"].clear()
    assert load(service, owner="a")["parts"]
    load(service, owner="b")
    assert counted == ["board", "board"]


def test_validation_still_applies_to_cached_bytes(counted):
    service = BoardImportService()
    load(service)
    with pytest.raises(UploadRejected) as error:
        load(service, limit=1)
    assert error.value.status == 413
    with pytest.raises(UploadRejected):
        load(service, declared=2 << 20)
    with pytest.raises(UnsupportedFormatError):
        load(service, data=b"unrecognized content", name="cached.xyz")
    with pytest.raises(UploadRejected) as error:
        load(service, data=b"")
    assert error.value.status == 400
    assert len(counted) == 1


def test_failed_imports_are_retried(counted):
    service = BoardImportService()
    for _ in range(2):
        with pytest.raises(InvalidBoardFile):
            load(service, data=b"not a board")
    assert len(counted) == 2


def test_encrypted_formats_recheck_their_key(counted):
    # The wrapper lets us test the service policy independently of encryption.
    service = BoardImportService()
    for _ in range(2):
        with pytest.raises(BoardParserError):
            load(service, data=b"not a valid encrypted board" * 4, name="board.pcb")
    assert len(counted) == 2


def test_cache_has_byte_and_entry_limits(counted):
    tiny = BoardImportService(max_cache_bytes=1)
    load(tiny)
    load(tiny)
    assert len(counted) == 2
    bounded = BoardImportService(max_entries=1)
    load(bounded, owner="a")
    load(bounded, owner="b")
    load(bounded, owner="a")
    assert len(counted) == 5


def test_concurrent_duplicates_parse_once(monkeypatch):
    service = BoardImportService()
    original = imports.parser_for
    started = threading.Event()
    release = threading.Event()
    calls = []

    class Parser:
        def __init__(self, real):
            self.real = real

        def parse(self, data, **kwargs):
            calls.append(1)
            started.set()
            assert release.wait(5)
            return self.real.parse(data, **kwargs)

    monkeypatch.setattr(imports, "parser_for", lambda path: Parser(original(path)))
    with ThreadPoolExecutor(max_workers=4) as pool:
        requests = [pool.submit(load, service) for _ in range(4)]
        try:
            assert started.wait(2)
        finally:
            release.set()
        results = [request.result(timeout=5) for request in requests]
    assert len(calls) == 1
    assert all(result == results[0] for result in results)


def test_library_duplicate_skips_parser_after_cache_restart(tmp_path, monkeypatch, counted):
    from api.board.library_store import LibraryStore

    store = LibraryStore(tmp_path, "owner-a")
    first = imports.import_into_library(io.BytesIO(DATA), "board.brd", 1 << 20, store)
    assert not first["duplicate"]
    store.update(first["board"]["id"], {"notes": "keep me"})
    monkeypatch.setattr(imports, "board_import_service", BoardImportService())
    again = imports.import_into_library(io.BytesIO(DATA), "renamed.brd", 1 << 20, store)
    assert again["duplicate"] and again["board"]["notes"] == "keep me"
    assert counted == ["board"]
    with pytest.raises(UploadRejected):
        imports.import_into_library(io.BytesIO(DATA), "renamed.brd", 1, store)
    with pytest.raises(UnsupportedFormatError):
        imports.import_into_library(io.BytesIO(b"unrecognized content"), "renamed.xyz", 1 << 20, store)


def test_concurrent_failed_imports_are_released_and_retryable(monkeypatch):
    service = BoardImportService()
    started = threading.Event()
    release = threading.Event()

    def fail():
        started.set()
        assert release.wait(5)
        raise InvalidBoardFile("invalid input")

    with ThreadPoolExecutor(max_workers=2) as pool:
        leader = pool.submit(service._get_or_build, ("failing",), fail)
        assert started.wait(2)
        follower = pool.submit(service._get_or_build, ("failing",), fail)
        release.set()
        for task in (leader, follower):
            with pytest.raises(InvalidBoardFile):
                task.result(timeout=5)
    assert service._get_or_build(("failing",), lambda: b"valid") == b"valid"


def test_content_detected_xzz_never_reuses_plain_import_cache(monkeypatch):
    from api.board.parser.test_link import BRDParser
    from api.board.parser.xzz import XZZParser
    from tests.board.test_xzz_decryption import _fixture

    calls = []
    def parse(self, raw, **kwargs):
        calls.append(1)
        return BRDParser().parse(DATA, **kwargs)
    monkeypatch.setattr(XZZParser, 'parse', parse)
    raw, _ = _fixture('DCFC12AC00000000')
    service = BoardImportService()
    load(service, data=raw, name='renamed.brd')
    load(service, data=raw, name='renamed.brd')
    assert len(calls) == 2
