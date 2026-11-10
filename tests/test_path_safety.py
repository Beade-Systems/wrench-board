"""Path-traversal guards on client-supplied slugs / repair ids."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.path_safety import is_safe_id, is_safe_slug
from api.pipeline.models import HypothesizeRequest, RepairRequest
from api.pipeline.orchestrator import _slugify


@pytest.mark.parametrize("slug", ["demo", "mnt-reform-motherboard", "iphone-x.v2", "a_b"])
def test_safe_slugs_accepted(slug):
    assert is_safe_slug(slug)


@pytest.mark.parametrize(
    "slug", ["", ".", "..", "../etc", "a/../b", "a..b", ".hidden", "UPPER", "a/b", "a\\b"]
)
def test_unsafe_slugs_rejected(slug):
    assert not is_safe_slug(slug)


@pytest.mark.parametrize("value", ["", ".", "..", "a/b", "../x", "x" * 65])
def test_unsafe_ids_rejected(value):
    assert not is_safe_id(value)


@pytest.mark.parametrize(
    "label", ["..", "../../etc", "..%2F..%2Fx", "./x", "a/../b", "...", ". .", ".git"]
)
def test_slugify_never_yields_traversal(label):
    slug = _slugify(label)
    assert is_safe_slug(slug), slug


def test_slugify_keeps_canonical_slugs_stable():
    assert _slugify("MNT Reform Motherboard") == "mnt-reform-motherboard"
    assert _slugify("mnt-reform-motherboard") == "mnt-reform-motherboard"
    assert _slugify("iPhone X v1.2") == "iphone-x-v1.2"


def _repair(**kw):
    base = {"device_label": "Some Device", "symptom": "dead board"}
    return RepairRequest(**(base | kw))


@pytest.mark.parametrize("slug", ["../../etc", "..", "a/b", ".x"])
def test_repair_request_rejects_traversal_slug(slug):
    with pytest.raises(ValidationError):
        _repair(device_slug=slug)


def test_repair_request_empty_slug_means_unset():
    assert _repair(device_slug="").device_slug is None
    assert _repair(device_slug="demo").device_slug == "demo"


@pytest.mark.parametrize("rid", ["../../x", "..", "a/b"])
def test_hypothesize_request_rejects_traversal_repair_id(rid):
    with pytest.raises(ValidationError):
        HypothesizeRequest(repair_id=rid)


def test_hypothesize_request_accepts_normal_repair_id():
    assert HypothesizeRequest(repair_id="94a040d9cde3").repair_id == "94a040d9cde3"


def test_repairs_route_rejects_traversal_slug(client, tmp_path, monkeypatch):
    from api import config

    monkeypatch.setattr(config, "_settings", None, raising=False)
    monkeypatch.setenv("MEMORY_ROOT", str(tmp_path / "memory"))
    r = client.post(
        "/pipeline/repairs",
        data={"device_label": "Some Device", "symptom": "dead board", "device_slug": "../../etc"},
    )
    monkeypatch.setattr(config, "_settings", None, raising=False)
    assert r.status_code == 422
    assert not (tmp_path / "etc").exists()


def test_board_render_rejects_traversal_slug(client):
    r = client.get("/api/board/render", params={"slug": "../board_assets/mnt-reform-motherboard"})
    assert r.status_code == 422


def test_generate_503_without_api_key(client, monkeypatch):
    from api import config

    monkeypatch.setattr(config, "_settings", None, raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    r = client.post("/pipeline/generate", json={"device_label": "Test Device X"})
    monkeypatch.setattr(config, "_settings", None, raising=False)
    assert r.status_code == 503
