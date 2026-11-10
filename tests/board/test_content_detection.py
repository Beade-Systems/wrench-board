import struct

from api.board.parser._fz_zlib import _detect_unit_scale
from api.board.parser.base import parser_for
from api.board.parser.cad_import import AllegroParser, EagleParser
from api.board.parser.fz import FZParser
from tests.board.test_fz_xor_parser import _MIN_BOARD, _make_zlib_payload


def test_renamed_plain_fz(tmp_path):
    path = tmp_path / "board.pcb"
    path.write_bytes(_make_zlib_payload(_MIN_BOARD))
    assert isinstance(parser_for(path), FZParser)
    assert len(parser_for(path).parse_file(path).parts) == 2


def test_xml_and_allegro_brd_distinguished(tmp_path):
    path = tmp_path / "board.brd"
    path.write_text('<?xml version="1.0"?><eagle version="9.0"><drawing/></eagle>')
    assert isinstance(parser_for(path), EagleParser)
    path.write_bytes(struct.pack("<III", 0x00140400, 0, 1) + bytes(64))
    assert isinstance(parser_for(path), AllegroParser)


def test_asus_mislabeled_units_and_translated_mm_board():
    schema = "UNIT:millimeters\nA!NET_NAME!REFDES!PIN_X!PIN_Y\n"
    assert _detect_unit_scale(schema + "S!GND!R1!0!0\nS!GND!R2!1500!1000\n") == 1
    # A translated millimeter board still has a small physical extent.
    assert (
        round(_detect_unit_scale(schema + "S!GND!R1!2000!2000\nS!GND!R2!2050!2050\n"), 2) == 39.37
    )


def test_fz_comma_decimal_coordinates(tmp_path):
    path = tmp_path / "comma.fz"
    path.write_bytes(_make_zlib_payload(_MIN_BOARD.replace("1.5", "1,5").replace("2.0", "2,0")))
    board = parser_for(path).parse_file(path)
    assert board.pins[0].pos.x == 2  # Existing board model rounds source coordinates.
    assert board.pins[0].pos.y == 2
