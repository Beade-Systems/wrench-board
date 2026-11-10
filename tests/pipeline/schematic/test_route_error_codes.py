"""Schematic routes expose stable error codes next to the English `detail`.

The UI localises by `code` (+ `params`) under `schematic.error.*`; `detail`,
status codes and routes are the pre-existing contract and must not move.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from api import config as config_mod

_I18N_DIR = Path(__file__).resolve().parents[3] / "web" / "i18n" / "_modules"


def _graph(slug: str) -> dict:
    return {
        "schema_version": "1.0",
        "device_slug": slug,
        "components": {
            "U7": {
                "refdes": "U7", "type": "ic", "value": None,
                "pages": [1], "pins": [], "populated": True,
            }
        },
        "nets": {},
        "power_rails": {
            "+5V": {"label": "+5V", "voltage_nominal": 5.0, "source_refdes": "U7"},
        },
        "typed_edges": [],
        "boot_sequence": [],
        "designer_notes": [],
        "ambiguities": [],
        "quality": {
            "total_pages": 1, "pages_parsed": 1, "orphan_cross_page_refs": 0,
            "nets_unresolved": 0, "components_without_value": 0,
            "components_without_mpn": 0, "confidence_global": 1.0,
            "degraded_mode": False,
        },
        "hierarchy": [],
    }


@pytest.fixture
def pack(memory_root: Path) -> str:
    slug = "demo"
    (memory_root / slug).mkdir()
    (memory_root / slug / "electrical_graph.json").write_text(json.dumps(_graph(slug)))
    return slug


def test_no_pack_and_no_schematic_codes(memory_root, client):
    res = client.get("/pipeline/packs/ghost/schematic")
    assert res.status_code == 404
    assert res.json() == {
        "detail": "No pack for device_slug='ghost'",
        "code": "no_pack",
        "params": {"slug": "ghost"},
    }

    (memory_root / "empty").mkdir()
    res = client.get("/pipeline/packs/empty/schematic")
    assert res.status_code == 404
    body = res.json()
    assert body["code"] == "no_schematic"
    assert body["params"] == {"slug": "empty"}
    assert body["detail"] == "No schematic ingested yet for device_slug='empty'"

    for path in ("schematic/boot", "schematic/passives"):
        res = client.get(f"/pipeline/packs/ghost/{path}")
        assert (res.status_code, res.json()["code"]) == (404, "no_schematic")


def test_malformed_graph_code(memory_root, client):
    (memory_root / "broken").mkdir()
    (memory_root / "broken" / "electrical_graph.json").write_text("{not json")
    res = client.get("/pipeline/packs/broken/schematic")
    assert res.status_code == 422
    body = res.json()
    assert body["code"] == "malformed_graph"
    assert body["params"] == {"slug": "broken"}
    assert body["detail"].startswith("Malformed electrical_graph.json for 'broken'")


def test_simulate_unknown_targets_are_coded(pack, client):
    res = client.post(
        f"/pipeline/packs/{pack}/schematic/simulate", json={"killed_refdes": ["U999", "U998"]}
    )
    assert res.status_code == 400
    assert res.json() == {
        "detail": "Unknown refdes: ['U999', 'U998']",
        "code": "unknown_refdes",
        "params": {"refdes": "U999, U998"},
    }


def test_hypothesize_errors_keep_structured_detail(pack, client):
    """`detail` stays the tool's result dict; code/params are added beside it."""
    res = client.post(
        f"/pipeline/packs/{pack}/schematic/hypothesize", json={"state_comps": {"U999": "dead"}}
    )
    assert res.status_code == 400
    body = res.json()
    assert body["code"] == "unknown_refdes"
    assert body["params"] == {"refdes": "U999"}
    assert body["detail"]["reason"] == "unknown_refdes"
    assert body["detail"]["invalid_refdes"] == ["U999"]

    res = client.post(
        f"/pipeline/packs/{pack}/schematic/hypothesize", json={"state_rails": {"+9V": "dead"}}
    )
    assert res.status_code == 400
    assert res.json()["code"] == "unknown_rail"
    assert res.json()["params"] == {"rails": "+9V"}

    res = client.post(
        "/pipeline/packs/ghost/schematic/hypothesize", json={"state_comps": {"U7": "dead"}}
    )
    assert (res.status_code, res.json()["code"]) == (404, "no_schematic")


def test_missing_api_key_code(pack, client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setattr(config_mod, "_settings", None)
    res = client.post(f"/pipeline/packs/{pack}/schematic/analyze-boot")
    assert res.status_code == 503
    body = res.json()
    assert body["code"] == "missing_api_key"
    assert body["detail"] == {
        "reason": "missing_api_key",
        "message": "ANTHROPIC_API_KEY is not set",
    }


def test_hypothesis_payload_carries_the_fields_the_ui_narrates_from(pack, client):
    """The UI renders the narrative client-side from these structured fields."""
    res = client.post(
        f"/pipeline/packs/{pack}/schematic/hypothesize", json={"state_rails": {"+5V": "dead"}}
    )
    assert res.status_code == 200
    body = res.json()
    assert {"state_comps", "state_rails", "metrics_comps", "metrics_rails"} <= set(
        body["observations_echo"]
    )
    for hyp in body["hypotheses"]:
        assert {"kill_refdes", "kill_modes", "metrics", "diff", "narrative"} <= set(hyp)
        assert {"dead_rails", "shorted_rails", "dead_comps_count", "anomalous_count"} <= set(
            hyp["cascade_preview"]
        )
        assert {"tp_comps", "tp_rails", "fp_comps", "fp_rails"} <= set(hyp["metrics"])


def test_every_route_code_has_en_and_de_text():
    """Codes raised by routes/schematic.py must be translatable in both languages."""
    import re

    src = (
        Path(__file__).resolve().parents[3] / "api" / "pipeline" / "routes" / "schematic.py"
    ).read_text(encoding="utf-8")
    codes = set(re.findall(r'CodedHTTPException\(\s*\d{3},\s*"([a-z_]+)"', src))
    codes |= {"unknown_refdes", "unknown_rail", "invalid_observations"}  # passed as `reason`
    assert len(codes) >= 12
    for lang in ("en", "de"):
        errors = json.loads((_I18N_DIR / f"schematic.{lang}.json").read_text(encoding="utf-8"))[
            "error"
        ]
        missing = sorted(codes - set(errors))
        assert not missing, f"schematic.error.* lacks {lang} text for {missing}"
