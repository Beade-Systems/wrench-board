"""Persistent library lifecycle and owner isolation, using real board parsers."""

from __future__ import annotations

import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

FIXTURE = Path(__file__).parent / "fixtures" / "minimal.brd"


def upload(client, *, owner=None, name="minimal.brd", data=None):
    return client.post(
        "/api/library/boards",
        files={"file": (name, FIXTURE.read_bytes() if data is None else data)},
        headers={"X-Owner-Ref": owner} if owner is not None else {},
    )


def test_import_list_reopen_download(client, memory_root):
    assert client.get("/api/library/boards").json() == {"boards": []}
    response = upload(client)
    assert response.status_code == 200
    result = response.json()
    assert result["duplicate"] is False
    metadata = result["board"]
    board_id = metadata["id"]
    assert metadata["parts_count"] == 2
    assert metadata["pins_count"] == 4
    assert metadata["nets_count"] == 2
    assert metadata["size_bytes"] == FIXTURE.stat().st_size
    assert client.get("/api/library/boards").json()["boards"] == [metadata]
    reopened = client.get(f"/api/library/boards/{board_id}").json()
    assert reopened["metadata"] == metadata
    assert {part["refdes"] for part in reopened["board"]["parts"]} == {"R1", "C1"}
    downloaded = client.get(f"/api/library/boards/{board_id}/download")
    assert downloaded.content == FIXTURE.read_bytes()
    assert 'filename="minimal.brd"' in downloaded.headers["content-disposition"]
    assert (memory_root / "_pcb_library" / "local" / board_id / "board.json").is_file()


def test_duplicate_preserves_original_and_notes(client, memory_root):
    board_id = upload(client).json()["board"]["id"]
    updated = client.patch(
        f"/api/library/boards/{board_id}",
        json={
            "title": "Meine Platine",
            "notes": "Revision B",
            "favorite": True,
        },
    )
    assert updated.status_code == 200
    result = upload(client, name="copy.brd").json()
    assert result["duplicate"] is True
    assert result["board"]["title"] == "Meine Platine"
    assert result["board"]["filename"] == "minimal.brd"
    assert result["board"]["favorite"] is True
    assert result["board"]["notes"] == "Revision B"
    assert len(client.get("/api/library/boards").json()["boards"]) == 1


@pytest.mark.parametrize(
    "method,suffix", [("get", ""), ("get", "/download"), ("patch", ""), ("delete", "")]
)
def test_other_owner_cannot_read_modify_download_or_delete(client, memory_root, method, suffix):
    board_id = upload(client, owner="owner-a").json()["board"]["id"]
    kwargs = {"json": {"title": "stolen"}} if method == "patch" else {}
    response = getattr(client, method)(
        f"/api/library/boards/{board_id}{suffix}", headers={"X-Owner-Ref": "owner-b"}, **kwargs
    )
    assert response.status_code == 404
    assert (
        client.get("/api/library/boards", headers={"X-Owner-Ref": "owner-b"}).json()["boards"] == []
    )
    assert client.get("/api/library/boards").json()["boards"] == []
    assert (
        len(client.get("/api/library/boards", headers={"X-Owner-Ref": "owner-a"}).json()["boards"])
        == 1
    )


def test_identical_board_is_independent_for_each_owner(client, memory_root):
    first = upload(client, owner="a").json()
    second = upload(client, owner="b").json()
    assert first["board"]["id"] == second["board"]["id"]
    assert second["duplicate"] is False
    client.delete(f"/api/library/boards/{first['board']['id']}", headers={"X-Owner-Ref": "a"})
    assert (
        len(client.get("/api/library/boards", headers={"X-Owner-Ref": "b"}).json()["boards"]) == 1
    )


def test_delete_removes_stored_files(client, memory_root):
    board_id = upload(client).json()["board"]["id"]
    response = client.delete(f"/api/library/boards/{board_id}")
    assert response.status_code == 204
    assert not response.content
    assert client.get(f"/api/library/boards/{board_id}").status_code == 404
    assert client.get(f"/api/library/boards/{board_id}/download").status_code == 404
    assert client.get("/api/library/boards").json()["boards"] == []
    assert not (memory_root / "_pcb_library" / "local" / board_id).exists()


@pytest.mark.parametrize(
    "name,data,status",
    [("empty.pcb", b"", 400), ("test.txt", b"abc", 415), ("broken.pcb", b"x" * 100, 422)],
)
def test_failed_import_leaves_no_library_entry(client, memory_root, name, data, status):
    assert upload(client, name=name, data=data).status_code == status
    assert client.get("/api/library/boards").json()["boards"] == []


def test_upload_limit_is_enforced(client, memory_root, monkeypatch):
    from api.config import get_settings

    monkeypatch.setattr(get_settings(), "board_upload_max_bytes", 100)
    assert upload(client).status_code == 413
    assert client.get("/api/library/boards").json()["boards"] == []


def test_paths_and_metadata_are_validated(client, memory_root):
    result = upload(client, name="../../outside.brd", owner="../../opaque-owner").json()
    board_id = result["board"]["id"]
    assert result["board"]["filename"] == "outside.brd"
    assert not (memory_root / "outside.brd").exists()
    for title in ("", "   ", "x" * 161):
        assert (
            client.patch(
                f"/api/library/boards/{board_id}",
                json={"title": title},
                headers={"X-Owner-Ref": "../../opaque-owner"},
            ).status_code
            == 422
        )
    assert client.get("/api/library/boards/not-a-content-hash").status_code == 404


def test_concurrent_duplicate_imports_publish_once(client, memory_root):
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda _: upload(client).json(), range(3)))
    assert sum(not result["duplicate"] for result in results) == 1
    assert len(client.get("/api/library/boards").json()["boards"]) == 1


def test_library_page_and_format_info(client):
    response = client.get("/library.html")
    assert response.status_code == 200
    assert '<html lang="' in response.text
    assert "/js/i18n.js" in response.text
    assert "/js/pcb_library.js" in response.text
    info = client.get("/api/library").json()
    assert {".pcb", ".brd", ".kicad_pcb"} <= set(info["extensions"])
    assert info["max_upload_bytes"] > 0


@pytest.mark.parametrize(
    "filename", ["mnt-reform-motherboard.brd", "mnt-reform-motherboard.kicad_pcb"]
)
def test_import_real_mnt_reform(client, memory_root, filename):
    if filename.endswith(".kicad_pcb"):
        dependency = subprocess.run(
            [os.environ.get("KICAD_PYTHON", "/usr/bin/python3"), "-c", "import pcbnew"],
            capture_output=True,
        )
        if dependency.returncode:
            pytest.skip("Native KiCad uploads require the system pcbnew module")
    path = Path(__file__).parents[2] / "board_assets" / filename
    with path.open("rb") as source:
        response = client.post("/api/library/boards", files={"file": (filename, source)})
    assert response.status_code == 200, response.text
    metadata = response.json()["board"]
    assert metadata["parts_count"] > 100
    assert metadata["pins_count"] > 1000


ITEM = {"refdes": "R1", "note": "Kurzschluss prüfen", "done": False, "pinned": True}


def worklist_url(board_id):
    return f"/api/library/boards/{board_id}/worklist"


def test_worklist_defaults_empty_and_persists(client, memory_root):
    board_id = upload(client).json()["board"]["id"]
    path = memory_root / "_pcb_library" / "local" / board_id / "worklist.json"
    assert client.get(worklist_url(board_id)).json() == {"items": []}
    assert not path.exists()
    saved = client.put(worklist_url(board_id), json={"items": [ITEM]})
    assert saved.status_code == 200
    assert saved.json() == {"items": [ITEM]}
    assert client.get(worklist_url(board_id)).json() == {"items": [ITEM]}
    assert json.loads(path.read_text(encoding="utf-8")) == [ITEM]
    assert not path.with_name(".worklist.json").exists()


def test_worklist_replaces_previous_items_and_applies_defaults(client, memory_root):
    board_id = upload(client).json()["board"]["id"]
    client.put(worklist_url(board_id), json={"items": [ITEM]})
    replaced = client.put(worklist_url(board_id), json={"items": [{"refdes": "C1"}]}).json()
    assert replaced == {"items": [{"refdes": "C1", "note": "", "done": False, "pinned": False}]}
    assert client.put(worklist_url(board_id), json={"items": []}).json() == {"items": []}
    assert client.get(worklist_url(board_id)).json() == {"items": []}


def test_worklist_does_not_change_board_or_metadata(client, memory_root):
    board_id = upload(client).json()["board"]["id"]
    before = client.get(f"/api/library/boards/{board_id}").content
    client.put(worklist_url(board_id), json={"items": [ITEM]})
    assert client.get(f"/api/library/boards/{board_id}").content == before


@pytest.mark.parametrize("method", ["get", "put"])
def test_worklist_is_isolated_between_owners(client, memory_root, method):
    board_id = upload(client, owner="owner-a").json()["board"]["id"]
    client.put(worklist_url(board_id), json={"items": [ITEM]}, headers={"X-Owner-Ref": "owner-a"})
    kwargs = {"json": {"items": []}} if method == "put" else {}
    response = getattr(client, method)(
        worklist_url(board_id), headers={"X-Owner-Ref": "owner-b"}, **kwargs
    )
    assert response.status_code == 404
    assert client.get(worklist_url(board_id)).status_code == 404
    kept = client.get(worklist_url(board_id), headers={"X-Owner-Ref": "owner-a"}).json()
    assert kept == {"items": [ITEM]}


def test_worklist_of_same_board_is_separate_for_each_owner(client, memory_root):
    board_id = upload(client, owner="a").json()["board"]["id"]
    upload(client, owner="b")
    client.put(worklist_url(board_id), json={"items": [ITEM]}, headers={"X-Owner-Ref": "a"})
    assert client.get(worklist_url(board_id), headers={"X-Owner-Ref": "b"}).json() == {"items": []}


def test_worklist_unknown_board_is_404(client, memory_root):
    for board_id in ("not-a-content-hash", "0" * 64):
        assert client.get(worklist_url(board_id)).status_code == 404
        assert client.put(worklist_url(board_id), json={"items": []}).status_code == 404


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"items": [{"note": "ohne Bauteil"}]},
        {"items": [{"refdes": ""}]},
        {"items": [{"refdes": "R1", "note": "x" * 2001}]},
        {"items": [{"refdes": "R1", "done": "vielleicht"}]},
        {"items": [{"refdes": "R1"}] * 2001},
    ],
)
def test_worklist_body_is_validated(client, memory_root, body):
    board_id = upload(client).json()["board"]["id"]
    client.put(worklist_url(board_id), json={"items": [ITEM]})
    assert client.put(worklist_url(board_id), json=body).status_code == 422
    assert client.get(worklist_url(board_id)).json() == {"items": [ITEM]}


def test_worklist_accepts_limits(client, memory_root):
    board_id = upload(client).json()["board"]["id"]
    items = [{"refdes": f"R{i}", "note": "", "done": False, "pinned": False} for i in range(2000)]
    items[0]["note"] = "x" * 2000
    assert client.put(worklist_url(board_id), json={"items": items}).status_code == 200
    assert client.get(worklist_url(board_id)).json() == {"items": items}


def test_delete_removes_worklist_and_reimport_starts_empty(client, memory_root):
    board_id = upload(client).json()["board"]["id"]
    client.put(worklist_url(board_id), json={"items": [ITEM]})
    assert client.delete(f"/api/library/boards/{board_id}").status_code == 204
    assert client.get(worklist_url(board_id)).status_code == 404
    assert not (memory_root / "_pcb_library" / "local" / board_id).exists()
    assert upload(client).json()["board"]["id"] == board_id
    assert client.get(worklist_url(board_id)).json() == {"items": []}


def test_duplicate_import_keeps_worklist(client, memory_root):
    board_id = upload(client).json()["board"]["id"]
    client.put(worklist_url(board_id), json={"items": [ITEM]})
    assert upload(client, name="copy.brd").json()["duplicate"] is True
    assert client.get(worklist_url(board_id)).json() == {"items": [ITEM]}


def test_get_json_stays_spliced_with_worklist_present(memory_root):
    from api.board.library_store import LibraryStore

    store = LibraryStore(memory_root)
    board = {"file_hash": "sha256:" + "a" * 64, "source_format": "brd", "parts": [], "pins": []}
    board["nets"] = []
    board_id = store.save(board, "a.brd", b"x")["board"]["id"]
    store.set_worklist(board_id, [ITEM])
    directory = store.root / board_id
    assert store.get_json(board_id) == b"".join(
        (
            b'{"metadata":',
            (directory / "metadata.json").read_bytes(),
            b',"board":',
            (directory / "board.json").read_bytes(),
            b"}",
        )
    )
    assert store.get(board_id)["board"] == board


def test_errors_carry_stable_codes_next_to_the_english_text(client, memory_root):
    missing = client.get(f"/api/library/boards/{'0' * 64}")
    assert missing.status_code == 404
    assert missing.json() == {"detail": "Board not found.", "code": "board_not_found"}
    board_id = upload(client).json()["board"]["id"]
    blank = client.patch(f"/api/library/boards/{board_id}", json={"title": "   "})
    assert (blank.status_code, blank.json()["code"]) == (422, "title_empty")


def test_import_errors_keep_their_kind_and_add_the_parser_code(client, memory_root):
    unknown = upload(client, name="board.unknownformat", data=b"data")
    assert unknown.status_code == 415
    detail = unknown.json()["detail"]
    assert detail["detail"] == "unsupported-format"
    assert (detail["code"], detail["params"]) == (
        "unsupported_extension",
        {"extension": ".unknownformat"},
    )
    assert isinstance(detail["message"], str) and detail["message"]
    # Kinds without a more specific parser code stay exactly as before.
    empty = upload(client, data=b"").json()["detail"]
    assert empty == {"detail": "empty-file", "message": "uploaded file is empty"}
