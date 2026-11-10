"""Abstract base and format dispatch for board file parsers."""

from __future__ import annotations

import hashlib
from abc import ABC, abstractmethod
from pathlib import Path

from api.board.model import Board


class BoardParserError(Exception):
    """Base class for parser errors.

    `code` / `params` are optional: a stable snake_case identifier the UI
    translates, next to the English message that stays the fallback.
    """

    def __init__(self, *args, code: str | None = None, params: dict | None = None):
        super().__init__(*args)
        self.code = code
        self.params = params or {}


class UnsupportedFormatError(BoardParserError):
    """Raised when no parser is registered for a file's extension."""


class InvalidBoardFile(BoardParserError):
    """Raised when a file is recognized but malformed or refused."""


class ObfuscatedFileError(InvalidBoardFile):
    """Raised on OBV-signature obfuscated files — we refuse to decode."""


class MissingFZKeyError(InvalidBoardFile):
    """Raised when a .fz file is uploaded without a decryption key configured.

    `.fz` files are XOR-scrambled with a per-vendor 44×32-bit key
    that ships separately from the file. Set `WRENCH_BOARD_FZ_KEY` in
    the environment (space-separated decimal or hex integers), or
    pass the key to `FZParser(key=...)` directly.
    """


class MalformedHeaderError(InvalidBoardFile):
    """Raised when a known block (e.g. `Parts:`, `Pins:`) is present but malformed."""

    def __init__(self, field: str):
        super().__init__(f"malformed header block: {field}")
        self.field = field


class PinPartMismatchError(InvalidBoardFile):
    """Raised when a pin references a part index that doesn't exist."""

    def __init__(self, pin_index: int):
        super().__init__(f"pin {pin_index} references an unknown part")
        self.pin_index = pin_index


class BoardParser(ABC):
    """Abstract parser. One subclass per file format."""

    extensions: tuple[str, ...] = ()

    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)
        # Only enforce on concrete subclasses — intermediate ABCs are allowed to be empty.
        if not getattr(cls, "__abstractmethods__", None) and not cls.extensions:
            raise TypeError(f"{cls.__name__} must declare a non-empty 'extensions' tuple")

    def parse_file(self, path: Path) -> Board:
        raw = path.read_bytes()
        file_hash = "sha256:" + hashlib.sha256(raw).hexdigest()
        return self.parse(raw, file_hash=file_hash, board_id=path.stem)

    @abstractmethod
    def parse(self, raw: bytes, *, file_hash: str, board_id: str) -> Board: ...


_REGISTRY: dict[str, type[BoardParser]] = {}


def register(parser_cls: type[BoardParser]) -> type[BoardParser]:
    """Decorator : register a parser by its extensions."""
    for ext in parser_cls.extensions:
        _REGISTRY[ext.lower()] = parser_cls
    return parser_cls


_BRD2_SNIFF = b"BRDOUT:"
_TEST_LINK_SNIFF = b"str_length:"
# Substitution-encoded ASCII boardview `.brd` 4-byte magic.
_SUBST_BRD_MAGIC = b"\x23\xe2\x63\x28"


def _sniff_brd_variant(path: Path) -> BoardParser | None:
    """Peek the first 256 bytes of a .brd file and return the right parser instance.

    The `.brd` extension hosts two incompatible formats — Test_Link (OBV's
    original layout, declared by `str_length:` / `var_data:` header tokens)
    and BRD2 (converter output from tools like `whitequark/kicad-boardview`,
    declared by `BRDOUT:` / `NETS:` / `PARTS:` UPPERCASE block markers). A
    byte-level sniff is enough to tell them apart — both markers live in the
    file's first few lines.

    Returns `None` if neither marker is present, letting the caller fall back
    to extension dispatch or raise `UnsupportedFormatError`.
    """
    try:
        with path.open("rb") as fh:
            head = fh.read(256)
    except OSError:
        return None
    if head.startswith(_SUBST_BRD_MAGIC):
        # Substitution-encoded ASCII boardview `.brd` — a fixed byte-substitution
        # over a line-based grammar. Decoded + parsed by SubstEncodedBoardParser.
        from api.board.parser.brd_subst import SubstEncodedBoardParser

        return SubstEncodedBoardParser()
    # Packed-binary `.brd` container — a small set of 4-byte prefixes (all
    # `..1200` / `..1300`). Partially decoded (parts + nets; no pins) by
    # PackedBinaryBoardParser. Checked before the ASCII markers below since the
    # binary body can incidentally contain those byte sequences.
    from api.board.parser.brd_packed import _PACKED_BRD_MAGICS

    if head[:4] in _PACKED_BRD_MAGICS:
        from api.board.parser.brd_packed import PackedBinaryBoardParser

        return PackedBinaryBoardParser()
    if _BRD2_SNIFF in head:
        from api.board.parser.brd2 import BRD2Parser

        return BRD2Parser()
    if _TEST_LINK_SNIFF in head:
        from api.board.parser.test_link import BRDParser

        return BRDParser()
    return None


def parser_for(path: Path) -> BoardParser:
    ext = path.suffix.lower()
    with path.open("rb") as source:
        head = source.read(4096)
    text = head.lstrip(b"\xef\xbb\xbf \r\n\t")
    allegro_versions = {0x00130000, 0x00130400, 0x00130C00, 0x00131000, 0x00131500,
                        0x00140400, 0x00140500, 0x00140600, 0x00140700, 0x00140E00, 0x00140900, 0x00141500, 0x00150000, 0x00150200}
    if (int.from_bytes(head[:4], "little") & 0xFFFFFF00 in allegro_versions or head[2:4] == b"\x12\x00") and head[8:12] == b"\x01\x00\x00\x00":
        from api.board.parser.cad_import import AllegroParser
        return AllegroParser()
    # Strong content signatures take precedence over possibly renamed extensions.
    if text.startswith(b"(kicad_pcb"):
        from api.board.parser.kicad import KicadPcbParser
        return KicadPcbParser()
    if b"<eagle" in text and (text.startswith(b"<?xml") or text.startswith(b"<eagle")):
        from api.board.parser.cad_import import EagleParser
        return EagleParser()
    if len(head) >= 64:
        from api.board.parser._xzz_engine.xzz_file import XZZFile
        if XZZFile.verify_format(head):
            from api.board.parser.xzz import XZZParser
            return XZZParser()
    if ext not in _REGISTRY or ext in (".brd", ".pcb", ".fz"):
        sniffed = _sniff_brd_variant(path)
        if sniffed is not None:
            return sniffed
    if head.startswith(_SUBST_BRD_MAGIC):
        sniffed = _sniff_brd_variant(path)
        if sniffed is not None:
            return sniffed
    # Only infer plain FZ when the decompressed prefix contains its schema.
    if head[4:6] in (b"\x78\x9c", b"\x78\xda", b"\x78\x01"):
        import zlib
        try:
            prefix = zlib.decompressobj().decompress(head[4:], 8192)
            if b"A!REFDES!" in prefix or b"A!NET_NAME!" in prefix:
                from api.board.parser.fz import FZParser
                return FZParser()
        except zlib.error:
            pass
    if ext == ".brd":
        sniffed = _sniff_brd_variant(path)
        if sniffed is not None:
            return sniffed
    cls = _REGISTRY.get(ext)
    if cls is None:
        if not ext:
            raise UnsupportedFormatError(
                f"file has no extension: {path.name!r}", code="no_extension"
            )
        raise UnsupportedFormatError(
            f"no parser registered for extension {ext!r}",
            code="unsupported_extension",
            params={"extension": ext},
        )
    return cls()
