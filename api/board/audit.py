"""One cancellable local corpus check with isolated parser workers."""

import json
import os
import subprocess
import sys
import threading
import time
from collections import Counter
from pathlib import Path

from fastapi import Depends
from pydantic import BaseModel, Field

from api.errors import CodedHTTPException
from api.workbench_settings import local_access, router

# Seconds one file may take before its parser worker is stopped.
_FILE_TIMEOUT = 60

_lock = threading.Lock()
_cancel = threading.Event()
_job = {"state": "idle", "checked": 0, "counts": {}}
_results = []


class AuditRequest(BaseModel):
    folder: str = ""
    limit: int = Field(default=100, ge=0, le=100000)


def _run(root, limit, max_bytes):
    global _job
    counts = Counter()
    try:
        from api.board.parser.base import _REGISTRY

        extensions = set(_REGISTRY) | {".pcbdoc", ".cae", ".cmpcbdoc", ".cspcbdoc"}
        for directory, folders, names in os.walk(root, followlinks=False):
            folders[:] = sorted(f for f in folders if not f.startswith("."))
            for name in sorted(names):
                if _cancel.is_set() or (limit and len(_results) >= limit):
                    break
                path = Path(directory) / name
                if path.suffix.lower() not in extensions or path.is_symlink():
                    continue
                with _lock:
                    _job["current"] = str(path.relative_to(root))
                started = time.monotonic()
                try:
                    if path.stat().st_size > max_bytes:
                        result = {
                            "status": "too_large",
                            "message": "Upload size limit exceeded",
                            "code": "upload_limit_exceeded",
                            "params": {"max_mb": round(max_bytes / 1048576)},
                        }
                    else:
                        process = subprocess.run(
                            [sys.executable, "-m", "api.board.audit_worker", str(path)],
                            capture_output=True,
                            timeout=_FILE_TIMEOUT,
                        )
                        if process.returncode:
                            result = {
                                "status": "error",
                                "message": "Parser process failed",
                                "code": "parser_process_failed",
                            }
                        else:
                            result = json.loads(process.stdout.decode().splitlines()[-1])
                except subprocess.TimeoutExpired:
                    result = {
                        "status": "timeout",
                        "message": f"Time limit of {_FILE_TIMEOUT} seconds reached",
                        "code": "timeout",
                        "params": {"seconds": _FILE_TIMEOUT},
                    }
                except Exception as exc:
                    result = {"status": "error", "message": str(exc)[:500]}
                result.update(
                    file=str(path.relative_to(root)), seconds=round(time.monotonic() - started, 2)
                )
                with _lock:
                    _results.append(result)
                    counts[result["status"]] += 1
                    _job.update(checked=len(_results), counts=dict(counts))
            if _cancel.is_set() or (limit and len(_results) >= limit):
                break
        with _lock:
            _job.update(state="cancelled" if _cancel.is_set() else "complete", current="")
    except Exception as exc:
        with _lock:
            _job.update(state="error", message=str(exc)[:500])


@router.post("/audit", dependencies=[Depends(local_access)])
def start_audit(request: AuditRequest):
    from api.board.source_catalog import _source
    from api.config import get_settings

    root = _source(None)
    target = (root / request.folder).resolve()
    if not target.is_relative_to(root) or not target.is_dir():
        raise CodedHTTPException(
            422,
            "audit_folder_outside",
            "The folder to check must be inside the active collection.",
        )
    with _lock:
        if _job["state"] == "running":
            raise CodedHTTPException(409, "audit_already_running", "A check is already running.")
        _results.clear()
        _cancel.clear()
        _job.clear()
        _job.update(state="running", checked=0, counts={}, root=str(target))
        threading.Thread(
            target=_run,
            args=(target, request.limit, get_settings().board_upload_max_bytes),
            daemon=True,
        ).start()
    return status()


@router.get("/audit", dependencies=[Depends(local_access)])
def status():
    with _lock:
        return {**_job, "recent": _results[-20:]}


@router.post("/audit/cancel", dependencies=[Depends(local_access)])
def cancel():
    _cancel.set()
    return {
        "message": (
            f"The check stops after the current file (at most {_FILE_TIMEOUT} seconds)."
        ),
        "code": "stopping",
        "params": {"seconds": _FILE_TIMEOUT},
    }


@router.get("/audit/report", dependencies=[Depends(local_access)])
def report():
    with _lock:
        return {**_job, "results": list(_results)}
