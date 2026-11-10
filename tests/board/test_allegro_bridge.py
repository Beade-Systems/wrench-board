import hashlib
import json
import subprocess

import pytest

from api.board.parser.allegro import BRIDGE, AllegroParser, board_from_boardripper, node_executable
from api.board.parser.base import InvalidBoardFile, parser_for


def payload():
    return {
        "formatVersion": "17.2",
        "outline": [{"x": -10, "y": -20}, {"x": 100, "y": 200}],
        "parts": [
            {
                "name": "U1",
                "type": "throughhole",
                "side": "bottom",
                "bounds": {"minX": -10, "minY": -20, "maxX": 20, "maxY": 40},
                "placementInferred": True,
                "meta": {"value": "IC", "package": "DIP", "note": "Recovered"},
                "pins": [
                    {
                        "name": "VDD",
                        "number": "A1",
                        "position": {"x": -1.5, "y": 2.75},
                        "side": "bottom",
                        "net": "VCC",
                        "drill": 12,
                        "padShape": "round",
                        "padWidth": 20,
                        "padHeight": 20,
                    }
                ],
            }
        ],
        "nets": [{"name": "VCC"}, {"name": "GND"}],
        "traces": [
            {
                "start": {"x": -1.5, "y": 2.75},
                "end": {"x": 100, "y": 2.75},
                "width": 5,
                "net": "VCC",
                "layer": 2,
            }
        ],
        "vias": [
            {"position": {"x": 100, "y": 2.75}, "diameter": 12, "net": "VCC", "layers": [0, 2]}
        ],
        "parserNotes": ["Partial source data"],
        "layerNames": ["Top", "Inner", "Bottom"],
    }


def test_mapping_preserves_coordinates_connectivity_and_uncertainty():
    board = board_from_boardripper(payload(), file_hash="hash", board_id="test")
    pin = board.pins[0]
    assert (pin.pos.x, pin.pos.y, pin.layer, pin.name) == (-1.5, 2.75, 3, "A1")
    assert board.parts[0].pin_refs == [0]
    assert board.parts[0].placement_inferred and board.parts[0].import_note == "Recovered"
    assert board.net_by_name("VCC").pin_refs == [0]
    assert board.net_by_name("GND").pin_refs == []
    assert board.traces[0].layer == 2 and board.vias[0].radius == 6
    assert board.parser_notes == ["Partial source data"]
    assert board.layer_names == ["Top", "Inner", "Bottom"]
    assert board.parts[0].layer == 2


def test_v15_warns_and_empty_results_fail():
    data = payload()
    data["formatVersion"] = "15.x"
    board = board_from_boardripper(data, file_hash="h", board_id="b")
    assert "experimental" in board.parser_notes[0]
    # The codes stay index-aligned: the upstream free-text note has none.
    assert board.parser_note_codes == [{"code": "allegro_v15_experimental", "params": {}}, None]
    data["parts"] = []
    with pytest.raises(InvalidBoardFile) as error:
        board_from_boardripper(data, file_hash="h", board_id="b")
    assert error.value.code == "allegro_no_parts"


def test_upstream_notes_get_codes_and_unknown_text_stays_plain():
    data = payload()
    data["parserNotes"] = [
        "Incomplete parse: only 10 of 40 board objects were read before a malformed block "
        "stopped the walk. Some parts, nets, or traces may be missing.",
        "3 components have a netlist but no stored position in this file. "
        "2 were located from the routing that ends on their pads and are drawn with a dashed "
        "amber outline \u2014 their pads are recovered, not read, and only some pads of each "
        "resolve. 1 could not be located (mounting holes and parts with too little routing).",
        "1 component have a netlist but no stored position in this file. ",
        "Something upstream added later",
    ]
    data["parts"][0]["meta"]["note"] = (
        "Position recovered from routing \u2014 5 of 8 pads located "
        "(3 from trace ends, 2 filled in from the pad pitch). Not stored in the file."
    )
    board = board_from_boardripper(data, file_hash="h", board_id="b")
    assert board.parser_notes == data["parserNotes"]
    assert board.parser_note_codes == [
        {"code": "allegro_incomplete_parse", "params": {"parsed": 10, "total": 40}},
        {
            "code": "allegro_unplaced_recovered_lost",
            "params": {"unplaced": 3, "recovered": 2, "lost": 1},
        },
        {"code": "allegro_unplaced", "params": {"unplaced": 1}},
        None,
    ]
    assert board.parts[0].import_note_code == {
        "code": "allegro_position_recovered_detail",
        "params": {"resolved": 5, "total": 8, "trace_ends": 3, "interpolated": 2},
    }
    # Free text the bridge does not know keeps its text and gets no code.
    assert (
        board_from_boardripper(payload(), file_hash="h", board_id="b").parts[0].import_note_code
        is None
    )


def test_subprocess_timeout_is_reported(monkeypatch):
    monkeypatch.setattr("api.board.parser.allegro.node_executable", lambda: "node")

    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired("node", 60)

    monkeypatch.setattr(subprocess, "run", timeout)
    with pytest.raises(InvalidBoardFile) as error:
        AllegroParser().parse(b"data", file_hash="h", board_id="b")
    assert (error.value.code, error.value.params) == ("allegro_timeout", {"seconds": 60})


@pytest.mark.skipif(not node_executable(), reason="Node not installed")
def test_actual_node_rejects_truncated_file():
    with pytest.raises(InvalidBoardFile) as error:
        AllegroParser().parse(b"\x00\x04\x14\x00", file_hash="h", board_id="b")
    assert error.value.code == "allegro_failed"


def test_v15_dispatch(tmp_path):
    path = tmp_path / "old.brd"
    path.write_bytes(bytes.fromhex("0a0a12000000000001000000") + bytes(256))
    assert isinstance(parser_for(path), AllegroParser)


def test_vendored_sources_match_pinned_revision():
    root = BRIDGE.parent
    manifest = json.loads((root / "upstream.json").read_text())
    for name, digest in manifest["files"].items():
        relative = (
            "vendor/" + name.removeprefix("src/frontend/src/") if name.startswith("src/") else name
        )
        assert hashlib.sha256((root / relative).read_bytes()).hexdigest() == digest


def test_heap_limit_and_helpful_out_of_memory_error(monkeypatch):
    from api.config import get_settings

    monkeypatch.setattr(get_settings(), "allegro_heap_mb", 768)
    monkeypatch.setattr("api.board.parser.allegro.node_executable", lambda: "node")

    def failed(command, **kwargs):
        assert "--max-old-space-size=768" in command
        return subprocess.CompletedProcess(
            command, -6, b"", b"FATAL ERROR: JavaScript heap out of memory"
        )

    monkeypatch.setattr(subprocess, "run", failed)
    with pytest.raises(InvalidBoardFile) as error:
        AllegroParser().parse(b"test", file_hash="h", board_id="b")
    assert (error.value.code, error.value.params) == ("allegro_out_of_memory", {"heap_mb": 768})
