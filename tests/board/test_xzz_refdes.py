"""Refdes normalisation and empty-result handling in the XZZ shim."""

from __future__ import annotations

import pytest

from api.board.parser._xzz_engine.models import Pin, Point, XZZPart
from api.board.parser._xzz_engine.xzz_file import XZZFile
from api.board.parser.base import InvalidBoardFile
from api.board.parser.xzz import XZZParser, _xzz_to_board


def _part(name: bytes, x: float = 1.0) -> XZZPart:
    pin = Pin(name=b"1", pos=Point(x, 2.0), net="GND", width=0.5, height=0.5)
    return XZZPart(x=x, y=2.0, name=name, pins=[pin])


def _xzz(*names: bytes) -> XZZFile:
    xzz = XZZFile()
    xzz.parts = [_part(name, x=float(i + 1)) for i, name in enumerate(names)]
    return xzz


def _refdes(xzz: XZZFile) -> list[str]:
    board = _xzz_to_board(xzz, file_hash="sha256:test", board_id="test")
    return [part.refdes for part in board.parts]


def test_percent_prefix_is_stripped_from_every_refdes():
    assert _refdes(_xzz(b"%C303", b"%U1", b"%R12")) == ["C303", "U1", "R12"]


def test_percent_prefix_is_stripped_after_test_pad_prefix():
    assert _refdes(_xzz(b"TEST_PAD_%TP7", b"%C1", b"%C2")) == ["TP7", "C1", "C2"]


def test_percent_part_never_overwrites_a_bare_sibling():
    assert _refdes(_xzz(b"C303", b"%C303", b"%C304")) == ["C303", "C304"]


def _parse_with_parts(monkeypatch, *names: bytes):
    def load(self, _raw):
        self.parts = [_part(name) for name in names]
        return True

    monkeypatch.setattr(XZZFile, "load", load)
    return XZZParser().parse(b"\0" * 64, file_hash="sha256:test", board_id="test")


def test_file_without_components_raises(monkeypatch):
    with pytest.raises(InvalidBoardFile, match="no usable components"):
        _parse_with_parts(monkeypatch)


def test_file_with_only_unusable_names_raises(monkeypatch):
    with pytest.raises(InvalidBoardFile, match=r"\(3 in file\)"):
        _parse_with_parts(monkeypatch, b"..", b"1781", b"B)")
