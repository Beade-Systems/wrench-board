"""Unit tests for `scripts/migrate_graph_rail_hygiene.py` (fast, filesystem-only)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

CLI_PATH = Path(__file__).resolve().parents[2] / "scripts" / "migrate_graph_rail_hygiene.py"


def _load():
    spec = importlib.util.spec_from_file_location("migrate_graph_rail_hygiene", CLI_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["migrate_graph_rail_hygiene"] = mod
    spec.loader.exec_module(mod)
    return mod


def _graph() -> dict:
    return {
        "components": {"J1": {}, "F1": {}, "SW1": {}, "U1": {}},
        "nets": {
            "VIN": {"label": "VIN", "is_power": True},
            "SW1": {"label": "SW1", "is_power": True},
        },
        "power_rails": {"VIN": {"label": "VIN"}, "SW1": {"label": "SW1"}},
        "boot_sequence": [
            {"index": 1, "rails_stable": ["F1", "SW1", "VIN"], "components_entering": ["J1", "F1"]},
            {"index": 2, "rails_stable": [], "components_entering": ["U1"]},
        ],
    }


def test_migrate_graph_drops_refdes_rails_and_non_rail_stable():
    mod = _load()
    g = _graph()
    summary = mod.migrate_graph(g)
    assert summary["colliding_rails"] == ["SW1"]
    assert sorted(summary["rails_stable_dropped"]) == [(1, "F1"), (1, "SW1")]
    assert set(g["power_rails"]) == {"VIN"}
    assert g["nets"]["SW1"]["is_power"] is False
    assert g["boot_sequence"][0]["rails_stable"] == ["VIN"]
    # components_entering is untouched — F1 is a real component.
    assert g["boot_sequence"][0]["components_entering"] == ["J1", "F1"]


def test_migrate_graph_is_idempotent():
    mod = _load()
    g = _graph()
    mod.migrate_graph(g)
    again = mod.migrate_graph(g)
    assert again == {"colliding_rails": [], "rails_stable_dropped": []}


def test_cli_dry_run_writes_nothing_and_apply_writes(tmp_path: Path):
    mod = _load()
    path = tmp_path / "dev" / ".cache_schematic" / "abc" / "electrical_graph.json"
    path.parent.mkdir(parents=True)
    original = json.dumps(_graph())
    path.write_text(original)

    assert mod.main(["--root", str(tmp_path)]) == 0
    assert path.read_text() == original

    assert mod.main(["--root", str(tmp_path), "--apply"]) == 0
    migrated = json.loads(path.read_text())
    assert set(migrated["power_rails"]) == {"VIN"}
