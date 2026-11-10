"""BoardRipper Allegro bridge, isolated in a bounded Node subprocess.

Upstream sources, license, fixed revision and the built JS are in _boardripper/.
No KiCad or network access is required while importing.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
from collections import defaultdict
from pathlib import Path

from api.board.model import Board, Layer, Net, Part, Pin, Point, Trace, Via
from api.board.parser.base import BoardParser, InvalidBoardFile
from api.board.parser.test_link import _GROUND_RE, _POWER_RE

BRIDGE = Path(__file__).parent / "_boardripper" / "bridge.cjs"
TIMEOUT_SECONDS = 60


# Upstream BoardRipper emits its notes as English sentences. The known shapes
# are recognised here so the UI can translate them; anything else stays text.
_UNPLACED_NOTE = re.compile(
    r"^(?P<unplaced>\d+) components? have a netlist but no stored position in this file\. "
    r"(?:(?P<recovered>\d+) were located from the routing .*?resolve\. )?"
    r"(?:(?P<lost>\d+) could not be located .*)?$",
    re.DOTALL,
)
_INCOMPLETE_NOTE = re.compile(
    r"^Incomplete parse: only (?P<parsed>\d+) of (?P<total>\d+) board objects were read "
)
_RECOVERED_NOTE = re.compile(
    r"^Position recovered from routing \u2014 (?P<resolved>\d+) of (?P<total>\d+) pads located"
    r"(?: \((?P<trace_ends>\d+) from trace ends, (?P<interpolated>\d+) filled in from the pad pitch\))?"
    r"\. Not stored in the file\.$"
)


def _numbers(match):
    return {name: int(value) for name, value in match.groupdict().items() if value is not None}


def parser_note_code(note):
    """`{code, params}` for a recognised upstream board note, else None."""
    match = _INCOMPLETE_NOTE.match(str(note))
    if match:
        return {"code": "allegro_incomplete_parse", "params": _numbers(match)}
    match = _UNPLACED_NOTE.match(str(note))
    if not match:
        return None
    params = _numbers(match)
    suffix = "_".join(name for name in ("recovered", "lost") if name in params)
    return {"code": f"allegro_unplaced_{suffix}" if suffix else "allegro_unplaced", "params": params}


def import_note_code(note):
    """`{code, params}` for a recognised upstream part note, else None."""
    match = _RECOVERED_NOTE.match(str(note or ""))
    if not match:
        return None
    params = _numbers(match)
    detailed = "interpolated" in params
    return {
        "code": "allegro_position_recovered_detail" if detailed else "allegro_position_recovered",
        "params": params,
    }


def node_executable():
    return shutil.which(os.environ.get("WRENCH_BOARD_NODE", "node"))


def bridge_available():
    return bool(node_executable() and BRIDGE.is_file())


def _point(value):
    x, y = float(value["x"]), float(value["y"])
    if not math.isfinite(x) or not math.isfinite(y):
        raise ValueError("non-finite board coordinate")
    return Point(x=x, y=y)


def _side(value):
    return {"top": Layer.TOP, "bottom": Layer.BOTTOM, "both": Layer.BOTH}.get(value, Layer.BOTH)


def board_from_boardripper(data, *, file_hash, board_id):
    """Map already absolute mil coordinates and rebuild global pin references."""
    notes = list(data.get("parserNotes") or [])
    # Index-aligned with `notes`; unrecognised upstream notes stay free text (None).
    note_codes: list[dict | None] = [parser_note_code(note) for note in notes]
    if str(data.get("formatVersion", "")).startswith("15"):
        notes.insert(0, "Allegro 15: experimental import; data may be incomplete.")
        note_codes.insert(0, {"code": "allegro_v15_experimental", "params": {}})
    parts, pins = [], []
    net_pins = defaultdict(list)
    for net in data.get("nets", []):
        net_pins[net["name"]]  # Retain named nets without resolved pads.
    names = set()
    for source in data["parts"]:
        name = source["name"]
        if not name or name in names:
            raise InvalidBoardFile(
                "allegro: empty or duplicate component reference",
                code="allegro_duplicate_refdes",
            )
        names.add(name)
        refs = []
        for number, pin in enumerate(source["pins"], 1):
            index = len(pins)
            refs.append(index)
            net = pin.get("net") or None
            if net:
                net_pins[net].append(index)
            diameter = max(float(pin.get("radius", 0)) * 2, 0)
            width = pin.get("padWidth", diameter)
            height = pin.get("padHeight", diameter)
            pins.append(
                Pin(
                    part_refdes=name,
                    index=number,
                    name=str(pin.get("number") or pin.get("name") or number),
                    pos=_point(pin["position"]),
                    net=net,
                    layer=Layer.BOTH if pin.get("drill", 0) > 0 else _side(pin.get("side")),
                    pad_shape={
                        "round": "circle",
                        "rect": "rect",
                        "roundrect": "roundrect",
                        "poly": "custom",
                    }.get(pin.get("padShape")),
                    pad_size=(width, height) if width > 0 and height > 0 else None,
                    pad_rotation_deg=pin.get("padAngleDeg"),
                )
            )
        bounds, meta = source["bounds"], source.get("meta") or {}
        parts.append(
            Part(
                refdes=name,
                layer=_side(source["side"]),
                is_smd=source["type"] == "smd",
                bbox=(
                    _point({"x": bounds["minX"], "y": bounds["minY"]}),
                    _point({"x": bounds["maxX"], "y": bounds["maxY"]}),
                ),
                pin_refs=refs,
                value=meta.get("value"),
                footprint=meta.get("package"),
                rotation_deg=source.get("angleDeg", meta.get("angleDeg")),
                placement_inferred=bool(source.get("placementInferred")),
                import_note=meta.get("note"),
                import_note_code=import_note_code(meta.get("note")),
            )
        )
    if not parts or not pins:
        raise InvalidBoardFile(
            "allegro: no components or pins read; this file variant is not supported yet",
            code="allegro_no_parts",
        )
    return Board(
        board_id=board_id,
        file_hash=file_hash,
        source_format="allegro",
        outline=[_point(p) for p in data["outline"]],
        parts=parts,
        pins=pins,
        nails=[],
        nets=[
            Net(
                name=name,
                pin_refs=refs,
                is_power=bool(_POWER_RE.match(name)),
                is_ground=bool(_GROUND_RE.match(name)),
            )
            for name, refs in net_pins.items()
        ],
        traces=[
            Trace(
                a=_point(t["start"]),
                b=_point(t["end"]),
                width=t["width"],
                layer=t.get("layer", 0),
                net=t.get("net") or None,
            )
            for t in data.get("traces", [])
        ],
        vias=[
            Via(
                pos=_point(v["position"]),
                radius=v["diameter"] / 2,
                net=v.get("net") or None,
                layer_span="ALL" if not v.get("layers") else "-".join(str(i) for i in v["layers"]),
            )
            for v in data.get("vias", [])
        ],
        parser_notes=notes,
        parser_note_codes=note_codes,
        layer_names=data.get("layerNames") or [],
    )


class AllegroParser(BoardParser):
    extensions = (".brd",)

    def parse(self, raw, *, file_hash, board_id):
        from api.config import get_settings

        heap_mb = get_settings().allegro_heap_mb
        executable = node_executable()
        if not executable or not BRIDGE.is_file():
            raise InvalidBoardFile(
                "Allegro needs Node.js 18 or newer and the bundled BoardRipper importer.",
                code="allegro_node_missing",
            )
        try:
            process = subprocess.run(
                [executable, f"--max-old-space-size={heap_mb}", str(BRIDGE)],
                input=raw,
                capture_output=True,
                timeout=TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            raise InvalidBoardFile(
                f"Allegro import exceeded the time limit of {TIMEOUT_SECONDS} seconds.",
                code="allegro_timeout",
                params={"seconds": TIMEOUT_SECONDS},
            ) from exc
        except OSError as exc:
            raise InvalidBoardFile(
                f"The Allegro importer could not be started: {exc}",
                code="allegro_start_failed",
                params={"reason": str(exc)},
            ) from exc
        if process.returncode:
            stderr = process.stderr.decode(errors="replace")
            if "heap out of memory" in stderr.lower() or "allocation failed" in stderr.lower():
                raise InvalidBoardFile(
                    f"Allegro import exceeded the memory limit of {heap_mb} MiB. "
                    "Raise the Allegro memory limit under Settings → Boardview keys and import.",
                    code="allegro_out_of_memory",
                    params={"heap_mb": heap_mb},
                )
            raise InvalidBoardFile(
                "Allegro import failed: " + stderr[-1000:],
                code="allegro_failed",
                params={"reason": stderr[-1000:]},
            )
        try:
            return board_from_boardripper(
                json.loads(process.stdout), file_hash=file_hash, board_id=board_id
            )
        except (ValueError, KeyError, TypeError) as exc:
            raise InvalidBoardFile(
                f"The Allegro importer returned invalid board data: {exc}",
                code="allegro_invalid_data",
                params={"reason": str(exc)},
            ) from exc
