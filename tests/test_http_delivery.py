"""Static delivery: gzip when reached directly, revalidation instead of re-download."""

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.testclient import TestClient

from api.main import _install_compression, app


def test_static_module_is_compressed_and_revalidated():
    client = TestClient(app)
    first = client.get("/js/main.js")
    assert first.status_code == 200
    assert first.headers["content-encoding"] == "gzip"
    assert first.headers["cache-control"] == "no-cache"

    second = client.get("/js/main.js", headers={"If-None-Match": first.headers["etag"]})
    assert second.status_code == 304


def test_compression_is_skipped_behind_the_front_door():
    hosted = FastAPI()
    _install_compression(hosted, service_token="secret")
    assert not any(m.cls is GZipMiddleware for m in hosted.user_middleware)

    standalone = FastAPI()
    _install_compression(standalone, service_token="")
    assert any(m.cls is GZipMiddleware for m in standalone.user_middleware)
