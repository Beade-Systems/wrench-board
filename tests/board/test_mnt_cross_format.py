"""Cross-format consistency on the MNT Reform motherboard (.kicad_pcb vs .brd).

The two files describe the same board; the .brd was exported from the
KiCad source. Pin lookups by the technician-facing pad number must land on
the same net in both formats.
"""

from pathlib import Path

import pytest

from api.board.parser.base import parser_for
from api.board.validator import resolve_pin, resolve_pin_matches

_ASSETS = Path(__file__).parent.parent.parent / "board_assets"
_KICAD = _ASSETS / "mnt-reform-motherboard.kicad_pcb"
_BRD = _ASSETS / "mnt-reform-motherboard.brd"


@pytest.fixture(scope="module")
def boards():
    if not (_KICAD.exists() and _BRD.exists()):
        pytest.skip("MNT Reform board pair not available")
    return parser_for(_KICAD).parse_file(_KICAD), parser_for(_BRD).parse_file(_BRD)


def test_kicad_pins_carry_pad_names(boards):
    kicad, _ = boards
    u1 = kicad.part_by_refdes("U1")
    names = [kicad.pins[i].name for i in u1.pin_refs]
    # KiCad lists the unnamed mechanical pads first: file order != pad number.
    assert names[0] is None
    assert kicad.pins[u1.pin_refs[2]].name == "1"


def test_u1_pin3_same_net_kicad_by_name_and_brd_by_index(boards):
    kicad, brd = boards
    k_pin = resolve_pin(kicad, "U1", "3")
    b_pin = resolve_pin(brd, "U1", 3)
    assert k_pin is not None and b_pin is not None
    assert k_pin.name == "3"
    assert k_pin.net == b_pin.net
    # An int on the kicad board also resolves by name first.
    assert resolve_pin(kicad, "U1", 3) is k_pin


def test_u1_every_numbered_pad_matches_brd_index(boards):
    kicad, brd = boards
    n = len(brd.part_by_refdes("U1").pin_refs)
    for i in range(1, n + 1):
        k_pin = resolve_pin(kicad, "U1", i)
        b_pin = resolve_pin(brd, "U1", i)
        if k_pin is None:
            continue  # no pad named str(i) on the kicad footprint
        assert k_pin.name == str(i)
        assert k_pin.net == b_pin.net, f"U1 pin {i}: {k_pin.net} != {b_pin.net}"


def test_repeated_pad_name_returns_all_matches(boards):
    kicad, _ = boards
    # U3 ships 11 pads named "33" (thermal / ground array).
    matches = resolve_pin_matches(kicad, "U3", "33")
    assert len(matches) > 1
    assert all(p.name == "33" for p in matches)


def test_number_missing_from_named_footprint_is_unknown(boards):
    kicad, _ = boards
    # U1 = 204 pads: two unnamed tabs, "1".."200", "SH1", "SH2". File
    # order must not stand in for the missing pad number 201.
    assert len(kicad.part_by_refdes("U1").pin_refs) == 204
    assert resolve_pin(kicad, "U1", 201) is None
    assert resolve_pin(kicad, "U1", "SH1").name == "SH1"


def test_kicad_and_brd_overlay_in_the_same_y_up_frame(boards):
    kicad, brd = boards
    ky = [p.y for p in kicad.outline]
    by = [p.y for p in brd.outline]
    assert (min(ky), max(ky)) == (min(by), max(by))
    for refdes in ("BT1", "U1", "J10"):
        kp, bp = kicad.part_by_refdes(refdes), brd.part_by_refdes(refdes)
        k_cy = (kp.bbox[0].y + kp.bbox[1].y) / 2
        b_cy = (bp.bbox[0].y + bp.bbox[1].y) / 2
        assert abs(k_cy - b_cy) < 10, f"{refdes}: kicad y {k_cy} vs brd y {b_cy}"
    # Pin-level: U1 pad N (kicad, by name) sits on brd pin N.
    for i in (1, 3, 100, 200):
        k_pin, b_pin = resolve_pin(kicad, "U1", i), resolve_pin(brd, "U1", i)
        assert abs(k_pin.pos.x - b_pin.pos.x) <= 1
        assert abs(k_pin.pos.y - b_pin.pos.y) <= 1
