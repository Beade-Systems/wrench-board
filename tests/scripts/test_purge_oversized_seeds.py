"""A failed cloud deletion must remain retryable in the local seed marker."""

import json

import httpx
import pytest

from scripts import purge_oversized_seeds as purge


@pytest.mark.parametrize("failure", [False, True, "network"])
def test_marker_only_drops_successful_deletions(tmp_path, monkeypatch, failure):
    marker = tmp_path / "memory" / "board" / "managed.json"
    marker.parent.mkdir(parents=True)
    marker.write_text(json.dumps({
        "memory_store_id": "store-test",
        "files": {"electrical_graph.json": "a", "nets_classified.json": "b", "keep.json": "c"},
    }))
    monkeypatch.setattr(purge, "REPO", tmp_path)
    monkeypatch.setattr(purge, "API_KEY", "test")
    monkeypatch.setattr("sys.argv", ["purge_oversized_seeds"])
    monkeypatch.setattr(purge, "_list_paths_to_ids", lambda *_: {
        purge.PURGE_PATHS[0]: "graph", purge.PURGE_PATHS[1]: "nets",
    })

    def delete(client, store_id, memory_id):
        if memory_id == "graph" and failure == "network":
            raise httpx.ConnectError("offline")
        return memory_id != "graph" or not failure

    monkeypatch.setattr(purge, "_delete", delete)
    assert purge.main() == (1 if failure else 0)
    files = json.loads(marker.read_text())["files"]
    assert files == ({"electrical_graph.json": "a", "keep.json": "c"} if failure else {"keep.json": "c"})


def test_dry_run_preserves_marker_and_does_not_delete(tmp_path, monkeypatch):
    marker = tmp_path / "memory" / "board" / "managed.json"
    marker.parent.mkdir(parents=True)
    original = '{"store_id": "store-test", "files": {"electrical_graph.json": "hash"}}'
    marker.write_text(original)
    monkeypatch.setattr(purge, "REPO", tmp_path)
    monkeypatch.setattr(purge, "API_KEY", "test")
    monkeypatch.setattr("sys.argv", ["purge_oversized_seeds", "--dry-run"])
    monkeypatch.setattr(purge, "_list_paths_to_ids", lambda *_: {purge.PURGE_PATHS[0]: "graph"})
    monkeypatch.setattr(purge, "_delete", lambda *_: pytest.fail("dry run tried to delete"))
    assert purge.main() == 0
    assert marker.read_text() == original
