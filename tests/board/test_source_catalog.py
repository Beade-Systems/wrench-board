"""Local source raster: indexing, search, safe downloads and click-to-open."""

import contextlib
import sqlite3
from pathlib import Path

import pytest

from api.board.source_catalog import documents_for_stem
from api.config import get_settings

FIXTURE = Path(__file__).parent / "fixtures" / "minimal.brd"


@pytest.fixture
def source(memory_root, tmp_path, monkeypatch):
    root = tmp_path / "source"
    for relative, content in {
        "Phones/Apple/iPhone 13 Pro/Logic board.brd": FIXTURE.read_bytes(),
        "Phones/Apple/iPhone 13/Schematic.pdf": b"%PDF-1.4\nexample",
        "Computers/ACER/BIOS.zip": b"zip data",
        "Drones/Air2/Memory.pcb": b"not a valid PCB",
        "Phones/Other/100%_board.brd": FIXTURE.read_bytes(),
        "Phones/Other/中文测试.pdf": b"%PDF-1.4\nChinese",
        "Phones/Other/logic.obdata": b"unsupported boardview",
        "manifest.txt": b"ignore",
    }.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    monkeypatch.setattr(get_settings(), "pcb_library_source_root", str(root))
    return root


def test_index_counts_formats_and_categories(client, source):
    info = client.get("/api/library/source").json()
    assert info["available"] is True
    assert info["total"] == 7
    assert info["kinds"] == {"board": 3, "pdf": 2, "archive": 1, "other": 1}
    assert {item["name"] for item in info["categories"]} == {"Phones", "Computers", "Drones"}
    # Browsing doesn't parse files or import a copy into the personal library.
    assert client.get("/api/library/boards").json()["boards"] == []


def test_search_matches_model_folders_and_multiple_words(client, source):
    result = client.get("/api/library/source/files", params={"q": "IPHONE logic pro"}).json()
    assert result["total"] == 1
    assert result["items"][0]["name"] == "Logic board.brd"
    assert (
        client.get("/api/library/source/files", params={"q": "中文", "kind": "pdf"}).json()["total"]
        == 1
    )


@pytest.mark.parametrize("query,expected", [("%", 1), ("_", 1), ("' OR 1=1 --", 0), ("\\", 0)])
def test_search_wildcards_are_literal_and_sql_is_bound(client, source, query, expected):
    result = client.get("/api/library/source/files", params={"q": query, "kind": "all"})
    assert result.status_code == 200
    assert result.json()["total"] == expected


def test_filters_pagination_and_limit(client, source):
    result = client.get(
        "/api/library/source/files", params={"kind": "all", "category": "Phones", "limit": 2}
    ).json()
    assert result["total"] == 5
    assert len(result["items"]) == 2
    second = client.get(
        "/api/library/source/files",
        params={"kind": "all", "category": "Phones", "limit": 2, "offset": 2},
    ).json()
    assert not {item["id"] for item in result["items"]} & {item["id"] for item in second["items"]}
    for params in ({"limit": 1000}, {"offset": -1}, {"sort": "injected"}, {"kind": "bad"}):
        assert client.get("/api/library/source/files", params=params).status_code == 422


def test_click_imports_one_board_and_keeps_original_unchanged(client, source):
    item = client.get("/api/library/source/files", params={"q": "logic pro"}).json()["items"][0]
    original = source / item["path"]
    before = original.read_bytes()
    response = client.post(f"/api/library/source/files/{item['id']}/open")
    assert response.status_code == 200, response.text
    assert response.json()["board"]["parts_count"] == 2
    board_id = response.json()["board"]["id"]
    assert client.get(f"/api/library/boards/{board_id}").json()["board"]["source_format"] == "brd"
    assert client.post(f"/api/library/source/files/{item['id']}/open").json()["duplicate"] is True
    assert len(client.get("/api/library/boards").json()["boards"]) == 1
    assert original.read_bytes() == before


def test_pdf_opens_inline_and_archives_download(client, source):
    for kind in ("pdf", "archive"):
        item = client.get("/api/library/source/files", params={"kind": kind}).json()["items"][0]
        response = client.get(f"/api/library/source/files/{item['id']}/download?inline=true")
        assert response.content == (source / item["path"]).read_bytes()
        assert response.headers["content-disposition"].startswith(
            "inline" if kind == "pdf" else "attachment"
        )
        assert client.post(f"/api/library/source/files/{item['id']}/open").status_code == 415


def test_local_catalog_is_not_exposed_to_gateway_owners(client, source):
    item = client.get("/api/library/source/files").json()["items"][0]
    headers = {"X-Owner-Ref": "tenant-a"}
    assert client.get("/api/library/source", headers=headers).json()["available"] is False
    assert client.get("/api/library/source/files", headers=headers).status_code == 404
    assert client.post("/api/library/source/refresh", headers=headers).status_code == 404
    assert (
        client.post(f"/api/library/source/files/{item['id']}/open", headers=headers).status_code
        == 404
    )
    assert (
        client.get(f"/api/library/source/files/{item['id']}/download", headers=headers).status_code
        == 404
    )


def test_refresh_discovers_new_and_removed_files(client, source):
    initial = client.get("/api/library/source").json()
    (source / "new.brd").write_bytes(FIXTURE.read_bytes())
    assert client.get("/api/library/source").json()["total"] == initial["total"]
    assert client.post("/api/library/source/refresh").json()["total"] == initial["total"] + 1
    item = client.get("/api/library/source/files", params={"q": "new.brd"}).json()["items"][0]
    (source / "new.brd").unlink()
    assert client.post(f"/api/library/source/files/{item['id']}/open").status_code == 404
    assert client.post("/api/library/source/refresh").json()["total"] == initial["total"]


def test_symlinks_cannot_expose_external_files(client, source, tmp_path):
    external = tmp_path / "external.pdf"
    external.write_bytes(b"private")
    (source / "symlink.pdf").symlink_to(external)
    assert (
        client.get("/api/library/source/files", params={"kind": "all", "q": "symlink"}).json()[
            "total"
        ]
        == 0
    )
    item = client.get("/api/library/source/files", params={"kind": "pdf"}).json()["items"][0]
    original = source / item["path"]
    original.unlink()
    original.symlink_to(external)
    assert client.get(f"/api/library/source/files/{item['id']}/download").status_code == 404


def test_missing_directory_is_reported_without_crashing(client, source, monkeypatch):
    monkeypatch.setattr(get_settings(), "pcb_library_source_root", "")
    assert client.get("/api/library/source").json()["available"] is False
    assert client.get("/api/library/source/files").status_code == 404


@pytest.fixture
def linked(memory_root, tmp_path, monkeypatch):
    """Boards and PDFs laid out like the real collection."""
    root = tmp_path / "linked"
    for relative in (
        "Computers/1 Laptop/APPLE/A29xx/A2992 820-02918/A2992 820-02918-A.brd",
        "Computers/1 Laptop/APPLE/A29xx/A2992 820-02918/A2992 820-02918 schematic.pdf",
        "Computers/1 Laptop/APPLE/A29xx/A2992 820-02918/Notes.pdf",
        "Computers/1 Laptop/APPLE/Cases/820-02918 repair.pdf",
        "Computers/1 Laptop/OEM factory/6 Compal/LAH792P-R20_MB.pcb",
        "Computers/1 Laptop/DELL/SCH/Inspiron LA-H792P schematic.pdf",
        "Computers/1 Laptop/OEM factory/Other/Mockingbird2 unknown.pcb",
        "Computers/1 Laptop/DELL/SCH/Mockingbird2 final.pdf",
        "Computers/1 Laptop/OEM factory/Other/Lonely99 board.pcb",
        "Computers/2 PC Motherboard/ASUS/B450M-K_1.02.fz",
        "Computers/2 PC Motherboard/GIGABYTE/B450M-K-1.0.tvw",
        "Computers/2 PC Motherboard/GIGABYTE/Docs/B450M-K_1.0 schematic.pdf",
    ):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")
    monkeypatch.setattr(get_settings(), "pcb_library_source_root", str(root))
    return root


def _board_id(client, query):
    return client.get("/api/library/source/files", params={"q": query}).json()["items"][0]["id"]


def _documents(client, query):
    response = client.get(f"/api/library/source/files/{_board_id(client, query)}/documents")
    assert response.status_code == 200, response.text
    return response.json()


def test_file_items_carry_parsed_identity(client, linked):
    item = client.get("/api/library/source/files", params={"q": "A2992"}).json()["items"][0]
    assert (item["board_number"], item["brand"], item["model"]) == ("820-02918", "Apple", "A2992")


def test_search_and_filter_use_canonical_board_number(client, linked):
    # The file is named LAH792P; only the parsed number has the hyphen.
    found = client.get("/api/library/source/files", params={"q": "la-h792p"}).json()
    assert [item["name"] for item in found["items"]] == ["LAH792P-R20_MB.pcb"]
    filtered = client.get(
        "/api/library/source/files", params={"board_number": "lah792p", "kind": "all"}
    ).json()
    assert filtered["total"] == 2
    assert {item["kind"] for item in filtered["items"]} == {"board", "pdf"}


def test_documents_for_imported_filename_use_the_board_number(client, linked):
    # A folder prefix in the name must not leak into the lookup.
    result = client.get(
        "/api/library/source/documents", params={"filename": "upload/A2992 820-02918-A.pcb"}
    ).json()
    assert result["total"] == len(result["items"]) >= 1
    assert {item["match"] for item in result["items"]} == {"board_number"}
    assert set(result["items"][0]) == {"id", "name", "path", "size_bytes", "match", "score"}


def test_documents_for_filename_requires_a_name(client, linked):
    assert client.get("/api/library/source/documents").status_code == 422


def test_documents_are_ranked_folder_then_number(client, linked):
    result = _documents(client, "A2992 820-02918-A")
    assert [item["match"] for item in result["items"]] == ["folder", "folder", "board_number"]
    assert result["items"][0]["name"] == "A2992 820-02918 schematic.pdf"
    assert result["total"] == 3
    scores = [item["score"] for item in result["items"]]
    assert scores == sorted(scores, reverse=True)
    assert set(result["items"][0]) == {"id", "name", "path", "size_bytes", "match", "score"}


def test_documents_match_compal_number_written_differently(client, linked):
    items = _documents(client, "LAH792P")["items"]
    assert [(item["name"], item["match"]) for item in items] == [
        ("Inspiron LA-H792P schematic.pdf", "board_number")
    ]


def test_documents_fall_back_to_similar_name(client, linked):
    items = _documents(client, "Mockingbird2 unknown")["items"]
    assert [(item["name"], item["match"]) for item in items] == [("Mockingbird2 final.pdf", "name")]


def test_documents_empty_when_nothing_relates(client, linked):
    assert _documents(client, "Lonely99") == {"items": [], "total": 0}


def test_vendor_name_does_not_link_across_brands(client, linked):
    assert _documents(client, "ASUS B450M-K") == {"items": [], "total": 0}
    assert [item["match"] for item in _documents(client, "GIGABYTE B450M-K")["items"]] == [
        "board_number"
    ]


def test_documents_in_a_mixed_folder_need_a_relation(client, linked):
    folder = linked / "Bin"
    folder.mkdir()
    for number in range(1000, 1006):
        (folder / f"820-0{number}.brd").write_bytes(b"x")
        (folder / f"820-0{number} schematic.pdf").write_bytes(b"x")
    client.post("/api/library/source/refresh")
    items = _documents(client, "820-01003.brd")["items"]
    assert [(item["name"], item["match"]) for item in items] == [
        ("820-01003 schematic.pdf", "folder")
    ]


def test_documents_capped_at_fifty(client, linked):
    folder = linked / "Computers/1 Laptop/APPLE/A29xx/A2992 820-02918"
    for index in range(60):
        (folder / f"extra {index}.pdf").write_bytes(b"x")
    client.post("/api/library/source/refresh")
    assert _documents(client, "A2992 820-02918-A")["total"] == 50


def test_documents_for_unknown_file_is_404(client, linked):
    assert client.get("/api/library/source/files/missing/documents").status_code == 404


def test_documents_for_stem_uses_number_then_name(client, linked):
    root = linked.resolve()
    by_number = documents_for_stem(root, "library copy LA-H792P.pcb")
    assert [(item["name"], item["match"]) for item in by_number] == [
        ("Inspiron LA-H792P schematic.pdf", "board_number")
    ]
    assert [item["match"] for item in documents_for_stem(root, "Mockingbird2.pcb")] == ["name"]
    assert documents_for_stem(root, "nothing.pcb") == []
    assert len(documents_for_stem(root, "820-02918.brd", limit=1)) == 1


def test_devices_group_counts_and_pagination(client, linked):
    result = client.get("/api/library/source/devices").json()
    apple = next(item for item in result["items"] if item["board_number"] == "820-02918")
    assert apple == {
        "brand": "Apple",
        "model": "A2992",
        "board_number": "820-02918",
        "board_count": 1,
        "pdf_count": 2,
    }
    assert result["total"] == len(result["items"])
    page = client.get("/api/library/source/devices", params={"limit": 1, "offset": 1}).json()
    assert page["items"] == result["items"][1:2]
    assert (page["total"], page["offset"], page["limit"]) == (result["total"], 1, 1)


def test_devices_search_matches_all_words(client, linked):
    found = client.get("/api/library/source/devices", params={"q": "apple a2992"}).json()
    assert [item["model"] for item in found["items"]] == ["A2992"]
    assert client.get("/api/library/source/devices", params={"q": "%"}).json()["total"] == 0


def test_new_routes_are_not_exposed_to_gateway_owners(client, linked):
    headers = {"X-Owner-Ref": "tenant-a"}
    file_id = _board_id(client, "A2992")
    assert (
        client.get(f"/api/library/source/files/{file_id}/documents", headers=headers).status_code
        == 404
    )
    assert client.get("/api/library/source/devices", headers=headers).status_code == 404


def test_older_catalog_schema_is_rebuilt(client, linked, memory_root):
    cache = Path(get_settings().memory_root) / "_pcb_catalog"
    cache.mkdir(parents=True, exist_ok=True)
    with contextlib.closing(sqlite3.connect(cache / "catalog.sqlite3")) as connection:
        connection.executescript("""
            CREATE TABLE files (id TEXT PRIMARY KEY, name TEXT, path TEXT);
            CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
        """)
        connection.execute(
            "INSERT INTO metadata VALUES ('source_root', ?)", (str(linked.resolve()),)
        )
        connection.commit()
    items = client.get("/api/library/source/files", params={"q": "A2992"}).json()["items"]
    assert items[0]["board_number"] == "820-02918"
    with contextlib.closing(sqlite3.connect(cache / "catalog.sqlite3")) as connection:
        indexes = {row[0] for row in connection.execute("SELECT name FROM sqlite_master")}
    assert {"files_directory", "files_board_number"} <= indexes
