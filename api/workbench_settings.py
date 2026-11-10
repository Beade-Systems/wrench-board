"""Local workbench preferences; secrets are never returned to the browser."""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

_LOCK = threading.RLock()
router = APIRouter(prefix="/api/workbench/settings", tags=["settings"])
SECRET_ENV = {
    "fz_key": "WRENCH_BOARD_FZ_KEY",
    "xzz_key": "WRENCH_BOARD_XZZ_KEY",
    "anthropic_api_key": "ANTHROPIC_API_KEY",
}


def settings_path(settings):
    return Path(settings.memory_root) / "_workbench_settings.json"


def read_preferences(settings):
    try:
        return json.loads(settings_path(settings).read_text())
    except FileNotFoundError:
        return {}


def apply_preferences(settings):
    values = read_preferences(settings)
    for name in (
        "pcb_library_source_root",
        "anthropic_model_main",
        "anthropic_model_fast",
        "anthropic_api_key",
        "allegro_heap_mb",
    ):
        if name in values:
            setattr(settings, name, values[name])
    for name, env in SECRET_ENV.items():
        if name in values:
            os.environ[env] = values[name]
    return settings


def local_access(request: Request):
    from api.config import get_settings

    if request.headers.get("x-owner-ref") is not None or get_settings().engine_service_token:
        raise HTTPException(404, "Einstellungen sind nur im eigenständigen Workbench verfügbar.")
    # All calls require a non-simple header. Cross-site forms cannot change
    # credentials or expose directories; CORS does not authorize this endpoint.
    if request.headers.get("x-workbench-settings") != "1":
        raise HTTPException(403, "Bitte die Einstellungsseite verwenden.")
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "Einstellungen nur vom selben Ursprung aufrufen.")


class Preferences(BaseModel):
    folders: list[str] = Field(default_factory=list, max_length=30)
    active_folder: str = ""
    allegro_heap_mb: int | None = Field(default=None, ge=128, le=4096)
    fz_key: str | None = Field(default=None, max_length=2000)
    xzz_key: str | None = Field(default=None, max_length=32)
    anthropic_api_key: str | None = Field(default=None, max_length=500)
    anthropic_model_main: str = Field(min_length=1, max_length=100)
    anthropic_model_fast: str = Field(min_length=1, max_length=100)


def normalize_fz(value: str) -> str:
    import struct

    value = value.strip()
    if not value:
        return ""
    words = re.findall(r"0x([0-9a-fA-F]{1,8})\b", value)
    try:
        if len(words) == 44:
            return struct.pack("<44I", *(int(w, 16) for w in words)).hex()
        if len(value) == 352:
            data = bytes.fromhex(value)
            if len(data) == 176:
                return data.hex()
        words = value.replace(",", " ").split()
        if len(words) == 44:
            return struct.pack("<44I", *(int(w, 0) for w in words)).hex()
    except (ValueError, struct.error):
        pass
    raise HTTPException(422, "FZ-Schlüssel: 44 Zahlen oder 352 Hex-Zeichen erforderlich.")


@router.get("", dependencies=[Depends(local_access)])
def current():
    from api.config import get_settings

    settings = get_settings()
    values = read_preferences(settings)
    root = settings.pcb_library_source_root
    return {
        "folders": values.get("folders", [root] if root else []),
        "active_folder": root,
        "allegro_heap_mb": settings.allegro_heap_mb,
        "anthropic_model_main": settings.anthropic_model_main,
        "anthropic_model_fast": settings.anthropic_model_fast,
        "configured": {name: bool(os.environ.get(env)) for name, env in SECRET_ENV.items()},
    }


@router.put("", dependencies=[Depends(local_access)])
def save(update: Preferences):
    from api.config import get_settings

    settings = get_settings()
    folders = []
    for entry in update.folders:
        path = Path(entry).expanduser().resolve()
        if not path.is_dir() or not os.access(path, os.R_OK | os.X_OK):
            raise HTTPException(422, f"Ordner nicht lesbar: {entry}")
        if str(path) not in folders:
            folders.append(str(path))
    active = str(Path(update.active_folder).expanduser().resolve()) if update.active_folder else ""
    if active and active not in folders:
        raise HTTPException(422, "Aktive Sammlung muss ein verknüpfter Ordner sein.")
    changes = update.model_dump(exclude_none=True)
    changes.pop("active_folder")
    changes.update(folders=folders, pcb_library_source_root=active)
    if "fz_key" in changes:
        changes["fz_key"] = normalize_fz(changes["fz_key"])
    if changes.get("xzz_key"):
        try:
            if len(bytes.fromhex(changes["xzz_key"])) != 8:
                raise ValueError()
        except ValueError:
            raise HTTPException(422, "XZZ-Schlüssel: 16 Hex-Zeichen erforderlich.") from None
    with _LOCK:
        values = read_preferences(settings)
        values.update(changes)
        path = settings_path(settings)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".settings-")
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump(values, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        apply_preferences(settings)
    return current()


@router.get("/directories", dependencies=[Depends(local_access)])
def directories(path: str = ""):
    from api.config import get_settings

    root = (
        Path(path or get_settings().pcb_library_source_root or Path.home()).expanduser().resolve()
    )
    try:
        entries = sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith("."))
    except OSError:
        raise HTTPException(422, "Ordner kann nicht gelesen werden.") from None
    return {
        "path": str(root),
        "parent": str(root.parent),
        "directories": [str(p) for p in entries[:500]],
    }


@router.post("/fz-key", dependencies=[Depends(local_access)])
def fetch_fz_key():
    import httpx

    # Explicit user action only; never download automatically on import.
    for owner in ("cryptonek", "yliu-d"):
        try:
            response = httpx.get(
                f"https://raw.githubusercontent.com/{owner}/illegal-numbers/main/FZkey.md",
                timeout=15,
            )
            response.raise_for_status()
            key = normalize_fz(response.text)
            # Return to the password input for review; saving is a separate action.
            return {"key": key}
        except (httpx.HTTPError, HTTPException):
            continue
    raise HTTPException(502, "Schlüsselquelle nicht erreichbar. Bitte manuell einfügen.")


@router.get("/formats", dependencies=[Depends(local_access)])
def format_capabilities():
    import subprocess

    from api.board.parser.allegro import bridge_available
    from api.board.parser.base import _REGISTRY

    native = {}
    try:
        result = subprocess.run(
            [
                os.environ.get("KICAD_PYTHON", "/usr/bin/python3"),
                "-c",
                'import json,pcbnew; print(json.dumps({"version":pcbnew.Version(),"plugins":[n for n in dir(pcbnew.PCB_IO_MGR) if n.isupper()]}))',
            ],
            capture_output=True,
            timeout=5,
        )
        if result.returncode == 0:
            native = json.loads(result.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return {
        "extensions": sorted(_REGISTRY),
        "kicad": native.get("version"),
        "native": {
            name: bridge_available() if name == "Allegro" else plugin in native.get("plugins", [])
            for name, plugin in (
                ("Altium", "ALTIUM_DESIGNER"),
                ("EAGLE", "EAGLE"),
                ("Allegro", "ALLEGRO"),
            )
        },
    }
