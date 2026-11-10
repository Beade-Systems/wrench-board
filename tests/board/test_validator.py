from pathlib import Path

from api.board.parser.test_link import BRDParser
from api.board.validator import (
    is_valid_refdes,
    resolve_net,
    resolve_part,
    resolve_pin,
    suggest_similar,
)

FIXTURE_DIR = Path(__file__).parent / "fixtures"


def _board():
    return BRDParser().parse_file(FIXTURE_DIR / "minimal.brd")


def test_is_valid_refdes_true():
    board = _board()
    assert is_valid_refdes(board, "R1") is True
    assert is_valid_refdes(board, "C1") is True


def test_is_valid_refdes_false():
    board = _board()
    assert is_valid_refdes(board, "U999") is False
    assert is_valid_refdes(board, "") is False
    assert is_valid_refdes(board, None) is False


def test_is_valid_refdes_case_insensitive_fallback():
    board = _board()
    assert is_valid_refdes(board, "r1") is True


def test_resolve_part():
    board = _board()
    r1 = resolve_part(board, "R1")
    assert r1 is not None
    assert r1.refdes == "R1"
    assert resolve_part(board, "U999") is None


def test_resolve_net():
    board = _board()
    vcc = resolve_net(board, "+3V3")
    assert vcc is not None
    assert vcc.name == "+3V3"
    assert resolve_net(board, "MISSING") is None


def test_resolve_pin():
    board = _board()
    pin = resolve_pin(board, "R1", 1)
    assert pin is not None
    assert pin.part_refdes == "R1"
    assert pin.index == 1
    assert resolve_pin(board, "R1", 99) is None
    assert resolve_pin(board, "U999", 1) is None


def test_suggest_similar_returns_close_matches():
    board = _board()
    suggestions = suggest_similar(board, "R2", k=3)
    # fixture only has R1 and C1 — R1 is closest to R2 (distance 1)
    assert "R1" in suggestions
    # empty string → empty list
    assert suggest_similar(board, "", k=3) == []


def test_suggest_similar_caps_at_k():
    board = _board()
    # fixture has 2 parts ; k=1 should return only the closest one
    one = suggest_similar(board, "R9", k=1)
    assert len(one) == 1
    assert one == ["R1"]


def test_suggest_similar_deterministic_order():
    """When multiple candidates tie on distance, alphabetical order wins.

    Both R1 and C1 are distance 2 from `X2` (two substitutions each).
    With lexicographic tiebreak, C1 must come before R1 ; the result is
    stable across calls regardless of the order parts are stored in.
    """
    board = _board()
    first = suggest_similar(board, "X2", k=2)
    second = suggest_similar(board, "X2", k=2)
    assert first == second
    assert first == ["C1", "R1"]  # alphabetical tiebreak pins the order


def test_suggest_similar_handles_whitespace():
    """Whitespace-only queries return []. Padded queries match stripped form."""
    board = _board()
    assert suggest_similar(board, "  ", k=3) == []
    assert suggest_similar(board, "\t", k=3) == []
    # `" R1 "` should match `R1` at distance 0 after strip — first result.
    padded = suggest_similar(board, " R1 ", k=1)
    assert padded == ["R1"]


def _board_with(refdes_list):
    from api.board.model import Board, Layer, Part, Point

    parts = [
        Part(
            refdes=r,
            layer=Layer.TOP,
            is_smd=True,
            bbox=(Point(x=0, y=0), Point(x=1, y=1)),
            pin_refs=[],
        )
        for r in refdes_list
    ]
    return Board(
        board_id="t", file_hash="sha256:0", source_format="test",
        outline=[], parts=parts, pins=[], nets=[], nails=[],
    )


def test_resolve_part_case_insensitive_returns_canonical():
    board = _board()
    part = resolve_part(board, "r1")
    assert part is not None and part.refdes == "R1"
    assert resolve_part(board, "  c1\t").refdes == "C1"


def test_resolve_part_ambiguous_case_keeps_exact_only():
    board = _board_with(["R1", "r1", "C1"])
    assert resolve_part(board, "R1").refdes == "R1"
    assert resolve_part(board, "r1").refdes == "r1"
    # Two candidates differ only by case and neither is the exact
    # spelling asked for: refuse rather than guess.
    board2 = _board_with(["Ab1", "aB1"])
    assert resolve_part(board2, "AB1") is None
    assert resolve_part(board2, "Ab1").refdes == "Ab1"


def test_resolve_part_bad_input():
    board = _board()
    assert resolve_part(board, None) is None
    assert resolve_part(board, "   ") is None
    assert resolve_part(board, 42) is None


def test_resolve_pin_case_insensitive_refdes():
    board = _board()
    pin = resolve_pin(board, "r1", 1)
    assert pin is not None and pin.part_refdes == "R1"


def test_suggest_similar_ranks_casefold_returns_original_spelling():
    board = _board_with(["C1", "D1", "F1", "U1", "U10"])
    assert suggest_similar(board, "u1", k=3) == ["U1", "C1", "D1"]
    assert suggest_similar(board, "u1", k=1) == ["U1"]


def test_suggest_similar_bad_k_and_input():
    board = _board()
    assert suggest_similar(board, "R1", k=0) == []
    assert suggest_similar(board, "R1", k=-2) == []
    assert suggest_similar(board, None, k=3) == []
