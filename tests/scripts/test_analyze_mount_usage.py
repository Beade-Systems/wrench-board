"""Regression checks for the offline mount-usage report."""

import json

import pytest

from scripts import analyze_mount_usage as usage


@pytest.mark.parametrize("wrapper", [None, "per_scenario", "scenarios", "results"])
def test_cli_accepts_supported_payloads(tmp_path, monkeypatch, capsys, wrapper):
    scenarios = [{"id": "repair-test", "turns": []}]
    payload = scenarios if wrapper is None else {wrapper: scenarios}
    source = tmp_path / "results.json"
    source.write_text(json.dumps(payload))
    monkeypatch.setattr("sys.argv", ["analyze_mount_usage", str(source)])
    assert usage.main() == 0
    assert "repair-test" in capsys.readouterr().out


@pytest.mark.parametrize("payload", ["null", "broken json", '{"results": [null]}'])
def test_cli_reports_invalid_payload(tmp_path, monkeypatch, capsys, payload):
    source = tmp_path / "results.json"
    source.write_text(payload)
    monkeypatch.setattr("sys.argv", ["analyze_mount_usage", str(source)])
    with pytest.raises(SystemExit) as error:
        usage.main()
    assert error.value.code == 2
    assert "error:" in capsys.readouterr().err


def test_search_directory_takes_precedence_over_search_pattern():
    path = usage.extract_path({
        "pattern": "wrench-board-global-patterns",
        "directory": "/mnt/memory/wrench-board-repair-123/",
    })
    assert usage.classify_mount(path) == "repair"


@pytest.mark.parametrize("path, expected", [
    ("/mnt/memory/wrench-board-global-patterns/a.md", "patterns"),
    ("/mnt/memory/wrench-board-global-playbooks", "playbooks"),
    ("/mnt/memory/wrench-board-repair-123/a.md", "repair"),
    ("/mnt/memory/wrench-board-global-patterns-prototype/a.md", "device"),
    ("/tmp/not-wrench-board-global-patterns/a.md", "other"),
])
def test_mount_names_use_component_boundaries(path, expected):
    assert usage.classify_mount(path) == expected


def test_server_side_calls_are_visible_and_totals_match():
    row = usage.analyze_scenario({"turns": [{
        "tool_calls": [{"name": "mb_get_component", "input": {}}],
        "memory_tool_calls": [
            {"name": "memory_search", "input": {}},
            {"name": "write", "input": {"path": "/mnt/memory/wrench-board-repair-x/log"}},
        ],
    }]})
    assert row["fs_total"] == sum(row["mount_totals"].values()) == 2
    report = usage.render_table([row])
    assert "memory_search → server-side" in report
    assert "scribe writes to repair mount: 1" in report
