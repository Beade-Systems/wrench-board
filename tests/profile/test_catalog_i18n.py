"""Every catalogue id must have an en + de UI label.

The frontend translates catalogue entries by their stable id
(`profile.catalog.{tools,skills,specialties}.<id>` in
`web/i18n/_modules/profile.<lang>.json`) and falls back to the backend's
English `label` when the key is missing. This test turns that silent fallback
into a failure: adding a catalogue entry requires adding both dictionary keys.
"""

import json
from pathlib import Path

import pytest

from api.profile.catalog import SKILLS_CATALOG, SPECIALTIES, TOOLS_CATALOG

_I18N_DIR = Path(__file__).resolve().parents[2] / "web" / "i18n" / "_modules"

_CATALOG_IDS = {
    "tools": [str(t.id) for t in TOOLS_CATALOG],
    "skills": [str(s.id) for s in SKILLS_CATALOG],
    "specialties": [sid for sid, _ in SPECIALTIES],
}


def _catalog_dict(lang: str) -> dict:
    data = json.loads((_I18N_DIR / f"profile.{lang}.json").read_text(encoding="utf-8"))
    return data["catalog"]


@pytest.mark.parametrize("lang", ["en", "de"])
@pytest.mark.parametrize("kind", sorted(_CATALOG_IDS))
def test_every_catalog_id_has_a_label(lang: str, kind: str):
    labels = _catalog_dict(lang).get(kind, {})
    missing = [i for i in _CATALOG_IDS[kind] if not str(labels.get(i, "")).strip()]
    assert not missing, (
        f"profile.catalog.{kind} is missing {lang} label(s) for {missing} — "
        f"add them to web/i18n/_modules/profile.{lang}.json"
    )


@pytest.mark.parametrize("lang", ["en", "de"])
@pytest.mark.parametrize("kind", sorted(_CATALOG_IDS))
def test_no_stale_catalog_labels(lang: str, kind: str):
    stale = sorted(set(_catalog_dict(lang).get(kind, {})) - set(_CATALOG_IDS[kind]))
    assert not stale, f"profile.catalog.{kind} has {lang} label(s) for unknown ids {stale}"


@pytest.mark.parametrize("kind", ["tools", "skills", "specialties"])
def test_english_dictionary_matches_backend_label(kind: str):
    """The English dictionary is the same wording the API ships as `label`."""
    backend = {
        "tools": {str(t.id): t.label for t in TOOLS_CATALOG},
        "skills": {str(s.id): s.label for s in SKILLS_CATALOG},
        "specialties": dict(SPECIALTIES),
    }[kind]
    assert _catalog_dict("en").get(kind, {}) == backend
