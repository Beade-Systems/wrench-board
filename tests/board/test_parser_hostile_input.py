"""Hostile / malformed board files must fail fast with a typed error."""

from __future__ import annotations

import struct
import time
from pathlib import Path

import pytest
from fastapi import HTTPException

from api.board.http_errors import import_errors
from api.board.parser.base import InvalidBoardFile, MalformedHeaderError
from api.board.parser.brd_packed import _HEAP_START, _walk_string_heap
from api.board.parser.test_link import BRDParser

FIXTURES = Path(__file__).parent / "fixtures"


def test_packed_heap_walk_is_linear_on_nul_free_junk():
    # Previously quadratic: unbounded find(b"\0") at every 4-byte step.
    raw = b"\x00" * _HEAP_START + b"9" * 2_000_000
    t0 = time.monotonic()
    assert _walk_string_heap(raw) == []
    assert time.monotonic() - t0 < 1.0


def test_packed_heap_walk_still_reads_entries():
    entry = struct.pack("<I", 0x0001_0000) + b"GND\x00"
    raw = b"\x00" * _HEAP_START + entry
    assert _walk_string_heap(raw) == [(1, "GND")]


def _brd_with_parts_line(tmp_path: Path, parts_line: str) -> Path:
    text = (FIXTURES / "minimal.brd").read_text().replace("R1 5 2", parts_line)
    p = tmp_path / "evil.brd"
    p.write_text(text)
    return p


@pytest.mark.parametrize("parts_line", ["R1 5 99999999999", "R1 5 3"])
def test_test_link_rejects_out_of_range_end_of_pins(tmp_path, parts_line):
    # 99999999999 used to allocate a giant range (memory DoS); 3 would
    # overlap C1's pins. Both must be a typed parse error.
    p = _brd_with_parts_line(tmp_path, parts_line)
    with pytest.raises((MalformedHeaderError, InvalidBoardFile)):
        BRDParser().parse_file(p)


def test_minimal_brd_still_parses():
    board = BRDParser().parse_file(FIXTURES / "minimal.brd")
    assert {p.refdes for p in board.parts} == {"R1", "C1"}


def test_truncated_jet_bv_is_typed_error(tmp_path):
    from api.board.parser.bv import BVParser

    raw = (FIXTURES / "jet4_min.bv").read_bytes()
    p = tmp_path / "cut.bv"
    p.write_bytes(raw[: max(64, len(raw) // 10)])
    with pytest.raises(InvalidBoardFile):
        BVParser().parse_file(p)


@pytest.mark.parametrize(
    "exc", [IndexError("x"), KeyError("x"), struct.error("x"), ValueError("x")]
)
def test_import_errors_maps_parser_crashes_to_422(exc):
    with pytest.raises(HTTPException) as info:
        with import_errors():
            raise exc
    assert info.value.status_code == 422
    assert info.value.detail["detail"] == "invalid-board-file"
