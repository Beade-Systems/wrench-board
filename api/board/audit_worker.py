"""Isolated, time-bounded board import probe (one file per process)."""

import json
import sys
from pathlib import Path

from api.board.parser.base import MissingFZKeyError, UnsupportedFormatError, parser_for
from api.config import get_settings


def main():
    get_settings()  # Apply saved runtime keys in the child, too.
    path = Path(sys.argv[1])
    try:
        board = parser_for(path).parse_file(path)
        result = {
            "status": "ok" if board.parts and board.pins else "incomplete",
            "format": board.source_format,
            "parts": len(board.parts),
            "pins": len(board.pins),
            "nets": len(board.nets),
        }
    except MissingFZKeyError as exc:
        result = {"status": "key_missing", "message": str(exc)}
    except UnsupportedFormatError as exc:
        result = {"status": "unsupported", "message": str(exc)}
    except Exception as exc:
        result = {"status": "error", "message": f"{type(exc).__name__}: {exc}"[:500]}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
