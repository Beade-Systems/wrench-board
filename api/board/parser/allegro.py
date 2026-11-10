"""BoardRipper Allegro bridge, isolated in a bounded Node subprocess.

Upstream sources, license, fixed revision and the built JS are in _boardripper/.
No KiCad or network access is required while importing.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from collections import defaultdict
from pathlib import Path

from api.board.model import Board, Layer, Net, Part, Pin, Point, Trace, Via
from api.board.parser.base import BoardParser, InvalidBoardFile
from api.board.parser.test_link import _GROUND_RE, _POWER_RE

BRIDGE = Path(__file__).parent / "_boardripper" / "bridge.cjs"
TIMEOUT_SECONDS = 60


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
    if str(data.get("formatVersion", "")).startswith("15"):
        notes.insert(0, "Allegro 15: experimenteller Import; Daten können unvollständig sein.")
    parts, pins = [], []
    net_pins = defaultdict(list)
    for net in data.get("nets", []):
        net_pins[net["name"]]  # Retain named nets without resolved pads.
    names = set()
    for source in data["parts"]:
        name = source["name"]
        if not name or name in names:
            raise InvalidBoardFile("allegro: leere oder doppelte Bauteilbezeichnung")
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
            )
        )
    if not parts or not pins:
        raise InvalidBoardFile(
            "allegro: keine Bauteile oder Pins gelesen; diese Dateivariante wird noch nicht unterstützt"
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
        layer_names=data.get("layerNames") or [],
    )


class AllegroParser(BoardParser):
    extensions = (".brd",)

    def parse(self, raw, *, file_hash, board_id):
        executable = node_executable()
        if not executable or not BRIDGE.is_file():
            raise InvalidBoardFile(
                "Allegro benötigt Node.js ab Version 18 und den mitgelieferten BoardRipper-Importer."
            )
        try:
            process = subprocess.run(
                [executable, "--max-old-space-size=512", str(BRIDGE)],
                input=raw,
                capture_output=True,
                timeout=TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as exc:
            raise InvalidBoardFile(
                "Allegro-Import überschreitet das Zeitlimit von 60 Sekunden."
            ) from exc
        except OSError as exc:
            raise InvalidBoardFile(
                f"Allegro-Importer konnte nicht gestartet werden: {exc}"
            ) from exc
        if process.returncode:
            raise InvalidBoardFile(
                "Allegro-Import fehlgeschlagen: " + process.stderr.decode(errors="replace")[-1000:]
            )
        try:
            return board_from_boardripper(
                json.loads(process.stdout), file_hash=file_hash, board_id=board_id
            )
        except (ValueError, KeyError, TypeError) as exc:
            raise InvalidBoardFile(
                f"Allegro-Importer lieferte ungültige Board-Daten: {exc}"
            ) from exc
