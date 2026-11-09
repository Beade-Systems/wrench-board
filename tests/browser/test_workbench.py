"""Real HTTP + Chromium checks. Run explicitly with make test-browser."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

pytestmark = pytest.mark.browser
ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests/board/fixtures/bilayer_minimal.brd"
SECOND_FIXTURE = ROOT / "tests/board/fixtures/minimal.brd"


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    directory = tmp_path_factory.mktemp("browser-server")
    memory = directory / "memory"
    pack = memory / "browser-board"
    uploads = pack / "uploads"
    uploads.mkdir(parents=True)
    shutil.copyfile(FIXTURE, uploads / "board.brd")
    (pack / "active_sources.json").write_text(json.dumps({"boardview": "board.brd"}))
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    source = directory / "catalog"
    source.mkdir()
    shutil.copyfile(FIXTURE, source / "catalog-board.brd")
    env = os.environ | {
        "PCB_LIBRARY_SOURCE_ROOT": str(source),
        "MEMORY_ROOT": str(memory),
        "ENGINE_SERVICE_TOKEN": "",
        "ENV": "test",
        "ANTHROPIC_API_KEY": "",
        "CLOUD_DEVICE_REGISTRY_URL": "",
        "CLOUD_DEVICE_REGISTRY_TOKEN": "",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    url = f"http://127.0.0.1:{port}"
    with (directory / "server.log").open("w") as log:
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "api.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            cwd=ROOT,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            for _ in range(100):
                if process.poll() is not None:
                    pytest.fail((directory / "server.log").read_text())
                try:
                    if httpx.get(url + "/health", timeout=1).status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                time.sleep(0.1)
            else:
                pytest.fail("Browser test server did not start")
            yield url
        finally:
            process.terminate()
            process.wait(timeout=20)


@pytest.fixture
def page(server):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        executable = os.getenv("CHROMIUM_EXECUTABLE")
        browser = playwright.chromium.launch(
            executable_path=executable,
            args=["--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
        )
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            page.goto(server + "/?board=browser-board", wait_until="domcontentloaded")
            page.wait_for_function("typeof window.PCBViewerOptimized === 'function'")
            yield page
            assert not errors, errors
        finally:
            context.close()
            browser.close()


def test_upload_contract_and_error_handling(server):
    with httpx.Client(base_url=server) as client:
        first = client.post("/api/board/parse", files={"file": ("board.brd", FIXTURE.read_bytes())})
        second = client.post("/api/board/parse", files={"file": ("copy.brd", FIXTURE.read_bytes())})
        assert first.status_code == second.status_code == 200
        assert first.json()["file_hash"] == second.json()["file_hash"]
        assert second.json()["board_id"] == "copy"
        assert (
            client.post("/api/board/parse", files={"file": ("empty.brd", b"")}).status_code == 400
        )
        assert (
            client.post(
                "/api/board/parse", files={"file": ("board.xyz", FIXTURE.read_bytes())}
            ).status_code
            == 415
        )
        assert client.get("/api/board/render", params={"slug": "browser-board"}).status_code == 200
        assert (
            client.get(
                "/api/board/render",
                params={"slug": "browser-board"},
                headers={"X-Owner-Ref": "other"},
            ).status_code
            == 404
        )


def test_viewer_interaction_overlays_and_lifecycle(page, server):
    # Exercise the real production page and geometry, not a Three.js mock.
    page.evaluate("""async () => {
      document.querySelector('[data-section-stub="pcb"]').classList.remove('hidden');
      const payload = await (await fetch('/api/board/render?slug=browser-board')).json();
      window.testViewer = new window.PCBViewerOptimized('pcb-canvas');
      testViewer.loadBoard(payload);
    }""")
    result = page.evaluate("""() => {
      const v = testViewer;
      const id = v.boardData.components[0].id;
      const before = v.frustumSize;
      v.zoomIn();
      const zoomed = v.frustumSize < before;
      v.zoomOut(); v.rotateRight(); v.rotateLeft();
      v.setSideMode('top'); v.setSideMode('bottom'); v.setSideMode('both');
      const found = v.searchAndFocus(id);
      v.addAnnotation(id, 'test label', 'test-note');
      v.removeAnnotation('test-note');
      v.setProtocolBadges([], null);
      v.clearProtocolBadges();
      v.clearSelection();
      return {zoomed, found, parts: v.boardData.components.length};
    }""")
    assert result["zoomed"] and result["found"] and result["parts"] > 0
    # Wheel handling follows the actual canvas event path.
    before = page.evaluate("testViewer.frustumSize")
    page.locator("#pcb-canvas").dispatch_event(
        "wheel", {"deltaY": -100, "clientX": 400, "clientY": 300}
    )
    assert page.evaluate("testViewer.frustumSize") < before
    # 100 requests in one turn must cause exactly one draw, and no idle loop.
    frames = page.evaluate("""async () => {
      const v = testViewer;
      await new Promise(requestAnimationFrame);
      const before = v.renderer.info.render.frame;
      for (let i=0; i<100; i++) v.requestRender();
      await new Promise(requestAnimationFrame);
      const after = v.renderer.info.render.frame;
      await new Promise(resolve => setTimeout(resolve, 100));
      return {draws: after-before, idle: v.renderer.info.render.frame-after};
    }""")
    assert frames == {"draws": 1, "idle": 0}
    page.evaluate("testViewer.dispose(); testViewer.dispose();")
    before = page.evaluate("testViewer.frustumSize")
    page.locator("#pcb-canvas").dispatch_event("wheel", {"deltaY": -100})
    assert page.evaluate("testViewer.frustumSize") == before


def test_color_settings_survive_reload(page):
    page.evaluate("window.setBoardviewNetColor('power', '#123456')")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_function("typeof window.getBoardviewColors === 'function'")
    assert page.evaluate("window.getBoardviewColors().power") == "#123456"


def test_library_import_duplicate_edit_filter_and_delete(page, server):
    from playwright.sync_api import expect

    page.goto(server + "/library.html", wait_until="domcontentloaded")
    expect(page.locator("#source-grid")).to_contain_text("catalog-board.brd")
    # A source click imports only this board and opens the real canvas viewer.
    page.locator("#source-grid .source-card").first.click()
    expect(page.locator("#viewer-status")).to_have_text("Platine geladen")
    expect(page.locator("#board-title")).to_have_text("catalog-board")
    page.locator("#file-input").set_input_files(str(FIXTURE))
    expect(page.locator("#notification")).to_contain_text("bereits in der Bibliothek")
    expect(page.locator("#board-count")).to_have_text("1")
    page.locator("#entity-search").fill("R1")
    expect(page.locator("#entity-list")).to_contain_text("R1")
    page.locator("#entity-list .entity-row").first.click()
    expect(page.locator("#selection")).to_contain_text("R1")
    page.locator('[data-side="1"]').click()
    expect(page.locator('[data-side="1"]')).to_have_attribute("aria-pressed", "true")
    page.locator('[data-side="3"]').click()
    page.locator("#mirror").check()
    page.locator("#zoom-in").click()
    page.locator("#fit").click()
    page.locator("#favorite").click()
    expect(page.locator("#favorite")).to_have_attribute("aria-pressed", "true")
    page.locator("#file-details summary").click()
    page.locator("#edit-title").fill("Browser-Testplatine")
    page.locator("#edit-notes").fill("Revision B")
    page.locator("#metadata-form button").click()
    expect(page.locator("#board-title")).to_have_text("Browser-Testplatine")
    with page.expect_download() as download:
        page.locator("#download").click()
    assert Path(download.value.path()).read_bytes() == FIXTURE.read_bytes()
    page.reload(wait_until="domcontentloaded")
    expect(page.locator("#board-title")).to_have_text("Browser-Testplatine")
    expect(page.locator("#edit-notes")).to_have_value("Revision B")
    page.locator("#file-details summary").click()
    page.locator("#delete").click()
    page.locator('#delete-dialog button[value="delete"]').click()
    expect(page.locator("#board-count")).to_have_text("0")
    expect(page.locator("#workspace")).to_be_hidden()
    # A failed import remains visible without creating a broken entry.
    page.locator("#file-input").set_input_files(
        {"name": "empty.brd", "mimeType": "application/octet-stream", "buffer": b""}
    )
    expect(page.locator("#notification")).to_contain_text("Die Datei ist leer")
    expect(page.locator("#board-count")).to_have_text("0")


def test_render_scheduler_coalesces_and_cancels(page):
    result = page.evaluate("""async () => {
      const {createRenderScheduler} = await import('/js/shared/render_scheduler.js');
      const raf = window.requestAnimationFrame, cancel = window.cancelAnimationFrame;
      const queued = new Map(); let next = 0, paints = 0, calls = 0;
      window.requestAnimationFrame = cb => { calls++; queued.set(++next, cb); return next; };
      window.cancelAnimationFrame = id => queued.delete(id);
      try {
        const scheduler = createRenderScheduler(() => { paints++; });
        for (let i=0; i<100; i++) scheduler.request();
        const pending = queued.size;
        const callbacks = [...queued.values()]; queued.clear(); callbacks.forEach(cb => cb());
        const idle = queued.size;
        scheduler.request(); scheduler.dispose(); scheduler.dispose(); scheduler.request();
        return {pending, paints, idle, remaining: queued.size, calls};
      } finally { window.requestAnimationFrame = raf; window.cancelAnimationFrame = cancel; }
    }""")
    assert result == {"pending": 1, "paints": 1, "idle": 0, "remaining": 0, "calls": 2}


def test_bridge_reuses_board_and_ignores_stale_loads(page, server):
    payload = httpx.get(server + "/api/board/render?slug=browser-board").json()
    page.evaluate("""() => {
      document.querySelector('[data-section-stub="pcb"]').classList.remove('hidden');
      window.loads = [];
      const load = window.PCBViewerOptimized.prototype.loadBoard;
      window.PCBViewerOptimized.prototype.loadBoard = function(payload) {
        loads.push(payload.testMarker || 'original'); return load.call(this, payload);
      };
    }""")
    page.evaluate("window.initBoardview(null)")
    page.evaluate("window.initBoardview(null)")
    assert page.evaluate("loads") == ["original"]
    # Deliberately resolve an old request after the new board is already loaded.
    page.evaluate("""() => {
      const realFetch = window.fetch;
      window.fetch = (url, options) => {
        if (String(url).includes('/api/board/render?slug=slow-board')) {
          return new Promise(resolve => { window.releaseSlow = resolve; });
        }
        return realFetch(url, options);
      };
    }""")
    page.evaluate("""async () => {
      const {setContext} = await import('/js/shared/context.js');
      setContext({device:'slow-board'}); window.slowLoad = window.initBoardview(null);
    }""")
    page.wait_for_function('typeof releaseSlow === "function"')
    page.route(
        "**/api/board/render?slug=fast-board",
        lambda route: route.fulfill(json=payload | {"testMarker": "fast"}),
    )
    page.evaluate("""async () => {
      const {setContext} = await import('/js/shared/context.js');
      setContext({device:'fast-board'}); await window.initBoardview(null);
    }""")
    page.evaluate(
        """async payload => {
      releaseSlow(new Response(JSON.stringify({...payload, testMarker:'stale'}), {status:200}));
      await slowLoad;
    }""",
        payload,
    )
    assert page.evaluate("loads") == ["original", "fast"]


def test_library_viewer_zoom_anchor_mirror_and_dispose(page, server):
    board = httpx.post(
        server + "/api/board/parse", files={"file": ("test.brd", FIXTURE.read_bytes())}
    ).json()
    result = page.evaluate(
        """async board => {
      const {LibraryViewer} = await import('/js/pcb_library_viewer.js');
      const container = document.createElement('div');
      container.style.cssText = 'position:fixed;top:0;left:0;width:600px;height:400px';
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:100%;height:100%';
      container.append(canvas); document.body.append(container);
      const v = new LibraryViewer(canvas); v.load(board);
      const anchor = {x:125, y:150};
      const before = v.world(anchor); v.zoom(2, anchor); const after = v.world(anchor);
      v.mirror = true;
      const roundtrip = v.world(v.screen(before));
      v.side = 1;
      const sides = [v.visible(1), v.visible(2), v.visible(3)];
      let paints = 0; const paint = v.paint.bind(v); v.paint = () => { paints++; paint(); };
      for (let i=0;i<100;i++) v.draw();
      await new Promise(requestAnimationFrame);
      const pixel = [...v.ctx.getImageData(0,0,canvas.width,canvas.height).data].some(x => x > 0);
      const frames = paints;
      v.draw(); v.dispose(); v.dispose();
      const scale = v.scale;
      canvas.dispatchEvent(new WheelEvent('wheel', {deltaY:-100}));
      await new Promise(requestAnimationFrame);
      container.remove();
      return {before, after, roundtrip, sides, pixel, frames, stopped:paints===frames && scale===v.scale};
    }""",
        board,
    )
    assert result["after"] == pytest.approx(result["before"])
    assert result["roundtrip"] == pytest.approx(result["before"])
    assert result["sides"] == [True, False, True]
    assert result["pixel"] and result["stopped"] and result["frames"] == 1


def test_library_workspace_tools(page, server):
    from playwright.sync_api import expect

    page.goto(server + "/library.html", wait_until="domcontentloaded")
    page.locator("#file-input").set_input_files([str(FIXTURE), str(SECOND_FIXTURE)])
    cards = page.locator("#board-list .board-card")
    expect(cards.nth(1)).to_be_visible()
    # Two boards open side by side as tabs; each keeps its own view.
    cards.nth(0).click()
    cards.nth(1).click()
    expect(page.locator(".pbt-tab")).to_have_count(2)
    page.locator("#mirror").check()
    page.locator(".pbt-label").nth(0).click()
    expect(page.locator("#mirror")).not_to_be_checked()
    page.locator(".pbt-label").nth(1).click()
    expect(page.locator("#mirror")).to_be_checked()
    page.locator(".pbt-label").nth(0).click()
    # Every line of the search is one more AND filter.
    page.locator("#entity-search").fill("R*\nno-such-value")
    expect(page.locator("#entity-list")).to_contain_text("Keine Treffer")
    page.locator("#entity-search").fill("R1")
    page.locator("#entity-list .entity-row").first.click()
    expect(page.locator("#selection h3")).to_have_text("R1")
    # Worklist entry, reached through the keyboard shortcut.
    page.get_by_text("Auf die Arbeitsliste →").click()
    page.keyboard.press("Alt+l")
    expect(page.locator(".wl-row")).to_contain_text("R1")
    page.keyboard.press("Alt+l")
    expect(page.locator("#selection")).to_be_visible()
    page.get_by_text("Pinbelegung vergleichen →").click()
    expect(page.locator("#part-compare")).to_be_visible()
    page.locator(".pcv-close").click()
    expect(page.locator("#part-compare")).to_be_hidden()
    page.locator("#butterfly").check()
    expect(page.locator('[data-side="1"]')).to_be_disabled()
    page.locator("#butterfly").uncheck()
    page.locator("#net-walk").select_option("1")
    page.locator('[data-tab="colors"]').click()
    expect(page.locator(".cr-section").first).to_be_visible()
    # Nothing in this catalog matches, so the picker stays off.
    expect(page.locator("#pdf-select")).to_be_disabled()
    expect(page.locator("#pdf-dock")).to_be_hidden()
    page.locator(".pbt-close").nth(1).click()
    page.locator(".pbt-close").nth(0).click()
    expect(page.locator("#catalog-browser")).to_be_visible()
