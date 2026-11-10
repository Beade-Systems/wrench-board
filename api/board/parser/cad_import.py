"""CAD import via KiCad's installed native importers and our common extractor."""

import os
import subprocess
import tempfile

from api.board.parser.allegro import AllegroParser as AllegroParser
from api.board.parser.base import BoardParser, InvalidBoardFile, register
from api.board.parser.kicad import _EXTRACT_SCRIPT, _json_to_board


class NativeCadParser(BoardParser):
    extensions = (".native-cad",)
    plugin = ""
    source_format = ""

    def parse(self, raw, *, file_hash, board_id):
        import json

        with tempfile.NamedTemporaryFile(suffix=self.extensions[0]) as source:
            source.write(raw)
            source.flush()
            try:
                process = subprocess.run(
                    [
                        os.environ.get("KICAD_PYTHON", "/usr/bin/python3"),
                        str(_EXTRACT_SCRIPT),
                        source.name,
                        self.plugin,
                    ],
                    capture_output=True,
                    timeout=60,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise InvalidBoardFile(
                    f"{self.source_format}: KiCad-Import nicht verfügbar: {exc}"
                ) from exc
        if process.returncode:
            message = process.stderr.decode(errors="replace")[-800:]
            raise InvalidBoardFile(f"{self.source_format}: {message}")
        try:
            board = _json_to_board(
                json.loads(process.stdout), file_hash=file_hash, board_id=board_id
            )
        except (ValueError, KeyError) as exc:
            raise InvalidBoardFile(f"{self.source_format}: ungültiges Importergebnis") from exc
        if not board.parts or not board.pins:
            raise InvalidBoardFile(f"{self.source_format}: keine Bauteile oder Pins importiert")
        board.source_format = self.source_format
        return board


@register
class AltiumParser(NativeCadParser):
    extensions = (".pcbdoc",)
    plugin = "ALTIUM_DESIGNER"
    source_format = "altium"


@register
class CircuitMakerParser(NativeCadParser):
    extensions = (".cmpcbdoc",)
    plugin = "ALTIUM_CIRCUIT_MAKER"
    source_format = "circuitmaker"


@register
class CircuitStudioParser(NativeCadParser):
    extensions = (".cspcbdoc",)
    plugin = "ALTIUM_CIRCUIT_STUDIO"
    source_format = "circuitstudio"


class EagleParser(NativeCadParser):
    extensions = (".brd",)
    plugin = "EAGLE"
    source_format = "eagle"

