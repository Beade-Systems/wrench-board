import struct
import time

import pytest
from fastapi.testclient import TestClient

import api.config as config
from api.main import app
from api.workbench_settings import apply_preferences, settings_path
from tests.board.test_fz_xor_cipher import TEST_KEY, _encrypt
from tests.board.test_fz_xor_parser import _MIN_BOARD, _make_zlib_payload

HEADERS = {"X-Workbench-Settings": "1"}


@pytest.fixture
def setup_settings(tmp_path, monkeypatch):
    root = tmp_path / "boards"
    root.mkdir()
    settings = config.Settings(
        _env_file=None,
        memory_root=str(tmp_path / "memory"),
        pcb_library_source_root=str(root),
        engine_service_token="",
    )
    monkeypatch.setattr(config, "_settings", settings)
    for name in ("WRENCH_BOARD_FZ_KEY", "WRENCH_BOARD_XZZ_KEY", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    return TestClient(app), settings, root


def update_body(root):
    return {
        "folders": [str(root)],
        "active_folder": str(root),
        "anthropic_model_main": "main-test",
        "anthropic_model_fast": "fast-test",
    }


def test_save_and_reload_redacts_secrets_and_changes_fz_immediately(setup_settings):
    client, settings, root = setup_settings
    raw = _encrypt(_make_zlib_payload(_MIN_BOARD), TEST_KEY)
    assert client.post("/api/board/parse", files={"file": ("test.fz", raw)}).status_code == 422
    body = update_body(root) | {
        "fz_key": struct.pack("<44I", *TEST_KEY).hex(),
        "anthropic_api_key": "test-secret",
    }
    response = client.put("/api/workbench/settings", headers=HEADERS, json=body)
    assert response.status_code == 200
    assert "test-secret" not in response.text and body["fz_key"] not in response.text
    assert client.post("/api/board/parse", files={"file": ("test.fz", raw)}).status_code == 200
    reloaded = apply_preferences(config.Settings(_env_file=None, memory_root=settings.memory_root))
    assert reloaded.pcb_library_source_root == str(root)
    assert reloaded.anthropic_api_key == "test-secret"
    assert settings_path(settings).stat().st_mode & 0o777 == 0o600
    response = client.put(
        "/api/workbench/settings", headers=HEADERS, json=update_body(root) | {"fz_key": ""}
    )
    assert response.status_code == 200
    assert (
        client.post("/api/board/parse", files={"file": ("test.fz", raw)}).json()["detail"]["detail"]
        == "fz-key-missing"
    )


def test_settings_access_and_invalid_update_is_atomic(setup_settings):
    client, settings, root = setup_settings
    assert client.get("/api/workbench/settings").status_code == 403
    assert (
        client.get(
            "/api/workbench/settings", headers=HEADERS | {"X-Owner-Ref": "tenant"}
        ).status_code
        == 404
    )
    assert (
        client.put(
            "/api/workbench/settings",
            headers=HEADERS | {"Origin": "https://other.test"},
            json=update_body(root),
        ).status_code
        == 403
    )
    assert (
        client.put(
            "/api/workbench/settings",
            headers=HEADERS,
            json=update_body(root) | {"fz_key": "broken"},
        ).status_code
        == 422
    )
    assert not settings_path(settings).exists()
    assert (
        client.put(
            "/api/workbench/settings",
            headers=HEADERS,
            json=update_body(root) | {"folders": ["/nonexistent-board-folder"]},
        ).status_code
        == 422
    )
    settings.engine_service_token = "cloud"
    assert client.get("/api/workbench/settings", headers=HEADERS).status_code in (401, 404)


def test_multiple_folders_and_directory_browser(setup_settings):
    client, settings, root = setup_settings
    second = root / "second"
    second.mkdir()
    response = client.put(
        "/api/workbench/settings",
        headers=HEADERS,
        json=update_body(root)
        | {"folders": [str(root), str(second)], "active_folder": str(second)},
    )
    assert response.status_code == 200
    assert settings.pcb_library_source_root == str(second)
    response = client.get(
        "/api/workbench/settings/directories", headers=HEADERS, params={"path": str(root)}
    )
    assert response.json()["directories"] == [str(second)]


def test_audit_real_fixture_and_reject_escape(setup_settings):
    client, settings, root = setup_settings
    (root / "sample.fz").write_bytes(_make_zlib_payload(_MIN_BOARD))
    assert (
        client.post(
            "/api/workbench/settings/audit", headers=HEADERS, json={"folder": ".."}
        ).status_code
        == 422
    )
    assert (
        client.post("/api/workbench/settings/audit", headers=HEADERS, json={"limit": 1}).status_code
        == 200
    )
    for _ in range(100):
        response = client.get("/api/workbench/settings/audit", headers=HEADERS).json()
        if response["state"] != "running":
            break
        time.sleep(0.05)
    assert response["state"] == "complete"
    assert response["counts"] == {"ok": 1}
    report = client.get("/api/workbench/settings/audit/report", headers=HEADERS).json()
    assert report["results"][0]["parts"] == 2
