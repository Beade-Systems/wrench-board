"""HTTP error translation shared by upload and catalog endpoints."""

import logging
import struct
from contextlib import contextmanager

from fastapi import HTTPException

from api.board.imports import UploadRejected
from api.board.parser.base import (
    BoardParserError,
    InvalidBoardFile,
    MalformedHeaderError,
    MissingFZKeyError,
    ObfuscatedFileError,
    PinPartMismatchError,
    UnsupportedFormatError,
)

logger = logging.getLogger(__name__)


@contextmanager
def import_errors():
    try:
        yield
    except UploadRejected as error:
        raise HTTPException(error.status, error.detail) from error
    except NotImplementedError as e:
        # Defensive: surface unimplemented parser branches as 501 rather
        # than letting them propagate as a generic 500.
        raise HTTPException(
            status_code=501,
            detail={"detail": "parser-not-implemented", "message": str(e)},
        ) from e
    except UnsupportedFormatError as e:
        raise HTTPException(
            status_code=415,
            detail={"detail": "unsupported-format", "message": str(e)},
        ) from e
    except MissingFZKeyError as e:
        # Specific 422 so the frontend can prompt the tech for a key
        # rather than dumping a generic invalid-board message.
        raise HTTPException(
            status_code=422,
            detail={"detail": "fz-key-missing", "message": str(e)},
        ) from e
    except ObfuscatedFileError as e:
        raise HTTPException(
            status_code=422,
            detail={"detail": "obfuscated", "message": str(e)},
        ) from e
    except MalformedHeaderError as e:
        raise HTTPException(
            status_code=422,
            detail={"detail": "malformed-header", "field": e.field, "message": str(e)},
        ) from e
    except PinPartMismatchError as e:
        raise HTTPException(
            status_code=422,
            detail={"detail": "pin-part-mismatch", "pin_index": e.pin_index, "message": str(e)},
        ) from e
    except InvalidBoardFile as e:
        raise HTTPException(
            status_code=422,
            detail={"detail": "invalid-board-file", "message": str(e)},
        ) from e
    except BoardParserError as e:
        raise HTTPException(
            status_code=422,
            detail={"detail": "parse-error", "message": str(e)},
        ) from e
    except OSError as e:
        raise HTTPException(
            status_code=400,
            detail={"detail": "io-error", "message": str(e)},
        ) from e
    except (IndexError, KeyError, ValueError, struct.error, MemoryError) as e:
        # Last line of defence: a parser bug on hostile / truncated input
        # must surface as a typed 422, not an HTTP 500. The traceback stays
        # server-side (it names internal paths); the client gets a generic
        # message.
        logger.warning("board parser crashed on malformed input", exc_info=True)
        raise HTTPException(
            status_code=422,
            detail={"detail": "invalid-board-file", "message": "file could not be parsed"},
        ) from e
