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


def error_detail(kind: str, error: Exception, **fields) -> dict:
    """Legacy `{detail: kind, message}` body, plus the parser's own stable
    `code` / `params` when it has one (the UI translates by code, most specific
    first, and falls back to `message`)."""
    detail = {"detail": kind, **fields, "message": str(error)}
    if getattr(error, "code", None):
        detail["code"] = error.code
        detail["params"] = dict(getattr(error, "params", None) or {})
    return detail


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
            detail=error_detail("parser-not-implemented", e),
        ) from e
    except UnsupportedFormatError as e:
        raise HTTPException(
            status_code=415,
            detail=error_detail("unsupported-format", e),
        ) from e
    except MissingFZKeyError as e:
        # Specific 422 so the frontend can prompt the tech for a key
        # rather than dumping a generic invalid-board message.
        raise HTTPException(
            status_code=422,
            detail=error_detail("fz-key-missing", e),
        ) from e
    except ObfuscatedFileError as e:
        raise HTTPException(
            status_code=422,
            detail=error_detail("obfuscated", e),
        ) from e
    except MalformedHeaderError as e:
        raise HTTPException(
            status_code=422,
            detail=error_detail("malformed-header", e, field=e.field),
        ) from e
    except PinPartMismatchError as e:
        raise HTTPException(
            status_code=422,
            detail=error_detail("pin-part-mismatch", e, pin_index=e.pin_index),
        ) from e
    except InvalidBoardFile as e:
        raise HTTPException(
            status_code=422,
            detail=error_detail("invalid-board-file", e),
        ) from e
    except BoardParserError as e:
        raise HTTPException(
            status_code=422,
            detail=error_detail("parse-error", e),
        ) from e
    except OSError as e:
        raise HTTPException(
            status_code=400,
            detail=error_detail("io-error", e),
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
