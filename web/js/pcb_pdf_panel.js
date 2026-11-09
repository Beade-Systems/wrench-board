// Embedded PDF schematic viewer for the PCB library page.
//
//   PdfView  — one document in one window: virtualized canvases, zoom/pan,
//              search, night mode, token clicks. Also used by the popout page.
//   PdfPanel — the host-facing API: a docked PdfView plus the wb-pdf
//              BroadcastChannel link to the detached window.
//
// pdf.js is imported from the CDN on the first open, never at page load.

const PDFJS_VERSION = '4.10.38';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/`;
const PDFJS_MODULE_URL = `${PDFJS_BASE}legacy/build/pdf.min.mjs`;
const PDFJS_WORKER_URL = `${PDFJS_BASE}legacy/build/pdf.worker.min.mjs`;

export const PDF_CHANNEL = 'wb-pdf';
const NIGHT_KEY = 'wb.pdf.night';
const POPPED_KEY = 'wb.pdf.popped';

const RANGE_CHUNK_BYTES = 256 * 1024;
const PAGE_GAP = 10;
const MIN_SCALE = 0.1;
const MAX_SCALE = 6;
const MAX_CANVAS_PIXELS = 16e6; // per page
const MAX_TOTAL_PIXELS = 48e6; // across all live canvases
const MOUNT_OVERSCAN = 2; // pages kept in the DOM beyond the viewport
const RENDER_OVERSCAN = 1; // pages rasterized beyond the viewport
const MAX_SEARCH_HITS = 50000;
const POPOUT_READY_TIMEOUT_MS = 10000;

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const TOKEN_RE = /[\p{L}\p{N}_]+(?:[<[]\d+(?::\d+)?[>\]])?[#+-]?(?![\p{L}\p{N}_])/gu;

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_MODULE_URL)
      .then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        // One worker per window: restarting it costs seconds on a slow CPU.
        return { lib, worker: new lib.PDFWorker() };
      })
      .catch((err) => {
        pdfjsPromise = null; // a later open may retry after a network blip
        throw err;
      });
  }
  return pdfjsPromise;
}

function readPref(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // storage blocked: the preference just does not persist
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function el(tag, className, attrs) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  return node;
}

function icon(body) {
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

const ICONS = {
  minus: icon('<path d="M3.5 8h9"/>'),
  plus: icon('<path d="M3.5 8h9M8 3.5v9"/>'),
  fit: icon('<path d="M1.5 8h13M4 5.5 1.5 8 4 10.5M12 5.5 14.5 8 12 10.5"/>'),
  up: icon('<path d="M3.5 10 8 5.5l4.5 4.5"/>'),
  down: icon('<path d="M3.5 6 8 10.5 12.5 6"/>'),
  moon: icon('<path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z"/>'),
  popout: icon('<path d="M9.5 2.5h4v4M13.5 2.5 8 8M6.5 3.5h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3"/>'),
  dock: icon('<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M2 10h12M8 4.8v3.4M6.4 6.8 8 8.4l1.6-1.6"/>'),
};

// Case folding that never changes the string length, so offsets found in the
// folded text stay valid in the original.
function foldCase(s) {
  const lower = s.toLowerCase();
  if (lower.length === s.length) return lower;
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i].toLowerCase();
    out += c.length === 1 ? c : s[i];
  }
  return out;
}

function isWordAt(text, index) {
  if (index < 0 || index >= text.length) return false;
  const code = text.charCodeAt(index);
  if (code < 128) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || code === 95 || (code >= 97 && code <= 122);
  }
  return WORD_CHAR.test(text[index]);
}

// Compact per-page text index: joined text plus each item's geometry in
// scale-1 viewport pixels (origin, run vector, glyph-height vector).
function buildPageText(items, viewport, Util) {
  const kept = [];
  let text = '';
  let separate = true;
  let prev = null;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    if (!item.str.trim()) {
      separate = true;
      continue;
    }
    const t = Util.transform(viewport.transform, item.transform);
    const runLen = Math.hypot(t[0], t[1]);
    const upLen = Math.hypot(t[2], t[3]);
    if (!runLen || !upLen || !item.width) {
      separate = true;
      continue;
    }
    const cur = {
      str: item.str,
      ox: t[4],
      oy: t[5],
      ux: (t[0] / runLen) * item.width,
      uy: (t[1] / runLen) * item.width,
      vx: (t[2] / upLen) * (item.height || upLen),
      vy: (t[3] / upLen) * (item.height || upLen),
    };
    if (prev && !separate && !continuesRun(prev, cur)) separate = true;
    if (text && separate) text += ' ';
    cur.start = text.length;
    text += cur.str;
    kept.push(cur);
    prev = cur;
    separate = !!item.hasEOL;
  }
  const count = kept.length;
  const starts = new Uint32Array(count + 1);
  const lens = new Uint32Array(count);
  const geom = new Float32Array(count * 6);
  kept.forEach((it, i) => {
    starts[i] = it.start;
    lens[i] = it.str.length;
    geom.set([it.ox, it.oy, it.ux, it.uy, it.vx, it.vy], i * 6);
  });
  starts[count] = text.length;
  return { text, starts, lens, geom, count };
}

// True when `cur` starts where `prev` ends on the same line: PDF producers
// sometimes split a single net name across several text items.
function continuesRun(prev, cur) {
  const uLen = Math.hypot(prev.ux, prev.uy);
  const vLen = Math.hypot(prev.vx, prev.vy);
  const dx = cur.ox - (prev.ox + prev.ux);
  const dy = cur.oy - (prev.oy + prev.uy);
  const along = (dx * prev.ux + dy * prev.uy) / uLen;
  const across = Math.abs((dx * prev.vx + dy * prev.vy) / vLen);
  return across < 0.35 * vLen && along > -0.25 * vLen && along < 0.12 * vLen;
}

function findMatches(hay, needle, wantSubstrings, sink) {
  const firstWord = isWordAt(needle, 0);
  const lastWord = isWordAt(needle, needle.length - 1);
  let at = hay.indexOf(needle);
  while (at !== -1) {
    const end = at + needle.length;
    const token = !(firstWord && isWordAt(hay, at - 1)) && !(lastWord && isWordAt(hay, end));
    if (token) sink.token.push(at);
    else if (wantSubstrings) sink.substring.push(at);
    at = hay.indexOf(needle, end);
  }
}

function itemIndexAt(pt, offset) {
  let lo = 0;
  let hi = pt.count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pt.starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Axis-aligned rects (scale-1 pixels) covering text[a..b). Glyph positions
// inside an item are interpolated by character count.
function rangeRects(pt, a, b) {
  const rects = [];
  if (!pt.count) return rects;
  for (let i = itemIndexAt(pt, a); i < pt.count && pt.starts[i] < b; i += 1) {
    const len = pt.lens[i];
    const t0 = clamp((a - pt.starts[i]) / len, 0, 1);
    const t1 = clamp((b - pt.starts[i]) / len, 0, 1);
    if (t1 <= t0) continue;
    const [ox, oy, ux, uy, vx, vy] = pt.geom.subarray(i * 6, i * 6 + 6);
    const xs = [];
    const ys = [];
    for (const t of [t0, t1]) {
      for (const s of [-0.15, 1]) {
        xs.push(ox + ux * t + vx * s);
        ys.push(oy + uy * t + vy * s);
      }
    }
    rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  return rects;
}

function tokenAt(pt, px, py) {
  let best = -1;
  let bestScore = Infinity;
  let bestT = 0;
  const { geom } = pt;
  for (let i = 0; i < pt.count; i += 1) {
    const j = i * 6;
    const dx = px - geom[j];
    const dy = py - geom[j + 1];
    const ux = geom[j + 2];
    const uy = geom[j + 3];
    const vx = geom[j + 4];
    const vy = geom[j + 5];
    const uu = ux * ux + uy * uy;
    const vv = vx * vx + vy * vy;
    const t = (dx * ux + dy * uy) / uu;
    const s = (dx * vx + dy * vy) / vv;
    // 1.5 px of slack: rotated schematic labels are only a few pixels thick.
    const slackU = 1.5 / Math.sqrt(uu);
    const slackV = 1.5 / Math.sqrt(vv);
    if (t < -slackU || t > 1 + slackU || s < -0.25 - slackV || s > 1.05 + slackV) continue;
    const score = Math.abs(s - 0.4);
    if (score < bestScore) {
      bestScore = score;
      best = i;
      bestT = t;
    }
  }
  if (best < 0) return null;
  const len = pt.lens[best];
  const offset = pt.starts[best] + clamp(Math.floor(bestT * len), 0, len - 1);
  return tokenInChunk(pt.text, offset);
}

function tokenInChunk(text, offset) {
  let a = offset;
  let b = offset;
  while (a > 0 && !/\s/.test(text[a - 1])) a -= 1;
  while (b < text.length && !/\s/.test(text[b])) b += 1;
  let best = null;
  let bestDist = Infinity;
  for (const m of text.slice(a, b).matchAll(TOKEN_RE)) {
    const start = a + m.index;
    const end = start + m[0].length;
    const dist = offset < start ? start - offset : offset >= end ? offset - end + 1 : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = { token: m[0], start, end };
    }
  }
  // Bare numbers are pin numbers and values, not jump targets.
  if (!best || best.token.length < 2 || !/\p{L}/u.test(best.token)) return null;
  return best;
}

function describeLoadError(err) {
  switch (err && err.name) {
    case 'InvalidPDFException':
      return 'Die Datei ist leer oder keine gültige PDF-Datei.';
    case 'MissingPDFException':
      return 'Die Datei wurde nicht gefunden.';
    case 'PasswordException':
      return 'Das PDF ist passwortgeschützt.';
    case 'UnexpectedResponseException':
      return `Der Server hat die Datei nicht geliefert (HTTP ${err.status}).`;
    default:
      return (err && err.message) || 'Unbekannter Fehler.';
  }
}

export class PdfView {
  /**
   * @param {HTMLElement} container
   * @param {object} options onTermClick(token), notify(text), onState({page,term}),
   *   onNight(bool), detach {icon,label,onClick} for the window-switch button
   */
  constructor(container, options = {}) {
    this._opts = options;
    this._container = container;
    this._ac = new AbortController();
    this._gen = 0;
    this._searchGen = 0;
    this._task = null;
    this._doc = null;
    this._lib = null;
    this._ready = Promise.resolve(false);
    this._zoomDebounce = 0;
    this._frame = 0;
    this._term = '';
    this._night = false;
    this._resetDocumentState();
    this._buildDom();
    this._bind();
    this.setNight(readPref(NIGHT_KEY), { silent: true });
    this._showMessage('Kein PDF geöffnet.');
  }

  get night() {
    return this._night;
  }

  get state() {
    return { page: this._page, term: this._term };
  }

  _resetDocumentState() {
    this._numPages = 0;
    this._pages = new Map(); // n -> Promise<PDFPageProxy>
    this._sizes = [];
    this._defaultSize = { w: 612, h: 792 };
    this._texts = []; // n -> page text index, once extracted
    this._textPromises = new Map();
    this._slots = new Map();
    this._tops = new Float64Array(1);
    this._contentW = 0;
    this._scale = 1;
    this._fit = true;
    this._page = 1;
    this._hits = [];
    this._hitsByPage = new Map();
    this._hitIdx = -1;
    this._hitMode = 'none';
    this._pumping = false;
    this._pumpAgain = false;
    this._layoutDirty = false;
    this._visible = null;
  }

  _buildDom() {
    const root = el('div', 'pdfp', { tabindex: '0' });
    this.root = root;

    const bar = el('div', 'pdfp-bar');
    this._titleEl = el('div', 'pdfp-title');
    bar.append(this._titleEl);

    const pager = el('label', 'pdfp-group pdfp-pager', { title: 'Seite' });
    this._pageInput = el('input', 'pdfp-page-input', {
      type: 'text',
      inputmode: 'numeric',
      'aria-label': 'Seite',
      value: '–',
    });
    this._pageTotal = el('span', 'pdfp-mono', {});
    this._pageTotal.textContent = '/ –';
    pager.append(this._pageInput, this._pageTotal);
    bar.append(pager);

    const zoom = el('div', 'pdfp-group');
    this._zoomOut = this._button(ICONS.minus, 'Verkleinern (−)');
    this._zoomLabel = el('span', 'pdfp-mono pdfp-zoom');
    this._zoomLabel.textContent = '–';
    this._zoomIn = this._button(ICONS.plus, 'Vergrößern (+)');
    this._fitBtn = this._button(ICONS.fit, 'Seitenbreite (0)');
    zoom.append(this._zoomOut, this._zoomLabel, this._zoomIn, this._fitBtn);
    bar.append(zoom);

    const search = el('div', 'pdfp-group pdfp-search');
    this._searchInput = el('input', 'pdfp-search-input', {
      type: 'search',
      placeholder: 'Im PDF suchen …',
      'aria-label': 'Im PDF suchen',
      spellcheck: 'false',
    });
    this._countEl = el('span', 'pdfp-mono pdfp-count', { role: 'status' });
    this._prevBtn = this._button(ICONS.up, 'Vorheriger Treffer (Umschalt+Enter)');
    this._nextBtn = this._button(ICONS.down, 'Nächster Treffer (Enter)');
    search.append(this._searchInput, this._countEl, this._prevBtn, this._nextBtn);
    bar.append(search);

    const tools = el('div', 'pdfp-group');
    this._nightBtn = this._button(ICONS.moon, 'Nachtmodus');
    this._nightBtn.setAttribute('aria-pressed', 'false');
    tools.append(this._nightBtn);
    if (this._opts.detach) {
      this._detachBtn = this._button(this._opts.detach.icon, this._opts.detach.label);
      tools.append(this._detachBtn);
    }
    bar.append(tools);

    this._scroller = el('div', 'pdfp-scroll');
    this._scroller.title = 'Mausrad: Zoom · Umschalt+Mausrad: Blättern · Ziehen: Verschieben · Klick auf Text: Auf dem Board suchen';
    this._pagesEl = el('div', 'pdfp-pages');
    this._scroller.append(this._pagesEl);

    this._msgEl = el('div', 'pdfp-msg', { role: 'status' });
    this._menu = el('div', 'pdfp-menu', { role: 'menu', hidden: '' });

    const stage = el('div', 'pdfp-stage');
    stage.append(this._scroller, this._msgEl);
    root.append(bar, stage, this._menu);
    this._container.append(root);
  }

  _button(svg, label) {
    const b = el('button', 'pdfp-btn', { type: 'button', title: label, 'aria-label': label });
    b.innerHTML = svg;
    return b;
  }

  _bind() {
    const signal = this._ac.signal;
    const on = (target, type, fn, extra) => target.addEventListener(type, fn, { signal, ...extra });
    const sc = this._scroller;

    on(sc, 'scroll', () => this._requestUpdate(), { passive: true });
    on(sc, 'wheel', (e) => this._onWheel(e), { passive: false });
    on(sc, 'pointerdown', (e) => this._onPointerDown(e));
    on(sc, 'pointermove', (e) => this._onPointerMove(e));
    on(sc, 'pointerup', (e) => this._onPointerUp(e));
    on(sc, 'pointercancel', () => { this._drag = null; });
    on(sc, 'pointerleave', () => this._clearHover());
    on(sc, 'contextmenu', (e) => this._onContextMenu(e));
    on(sc, 'touchstart', (e) => this._onTouchStart(e), { passive: true });
    on(sc, 'touchmove', (e) => this._onTouchMove(e), { passive: false });
    on(this.root, 'keydown', (e) => this._onKey(e));
    on(this.root.ownerDocument, 'pointerdown', (e) => {
      if (!this._menu.contains(e.target)) this._closeMenu();
    });

    on(this._zoomIn, 'click', () => this._zoomBy(1.25));
    on(this._zoomOut, 'click', () => this._zoomBy(0.8));
    on(this._fitBtn, 'click', () => this._fitWidth());
    on(this._nightBtn, 'click', () => this.setNight(!this._night));
    on(this._nextBtn, 'click', () => this.next());
    on(this._prevBtn, 'click', () => this.previous());
    if (this._detachBtn) on(this._detachBtn, 'click', () => this._opts.detach.onClick());

    on(this._pageInput, 'focus', () => this._pageInput.select());
    on(this._pageInput, 'keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const n = parseInt(this._pageInput.value, 10);
      if (Number.isFinite(n)) this._gotoPage(clamp(n, 1, this._numPages || 1));
      this.root.focus({ preventScroll: true });
    });
    on(this._pageInput, 'blur', () => { this._pageInput.value = this._numPages ? String(this._page) : '–'; });

    on(this._searchInput, 'input', () => {
      clearTimeout(this._searchDebounce);
      this._searchDebounce = setTimeout(() => this.search(this._searchInput.value), 250);
    });
    on(this._searchInput, 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(this._searchDebounce);
        if (this._searchInput.value.trim() !== this._term) this.search(this._searchInput.value);
        else if (e.shiftKey) this.previous();
        else this.next();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this._searchInput.value = '';
        this.search('');
        this.root.focus({ preventScroll: true });
      }
    });

    this._resizeObserver = new ResizeObserver(() => this._onResize());
    this._resizeObserver.observe(sc);
  }

  // ---------------------------------------------------------------- document

  async open({ url, title, page = 1, term = '' }) {
    const gen = this._teardownDocument();
    this._titleEl.textContent = title || '';
    this._titleEl.title = title || '';
    this._searchInput.value = term;
    this._term = '';
    this._setCount('');
    this._showMessage('PDF wird geladen …');
    let settle;
    this._ready = new Promise((resolve) => { settle = resolve; });
    try {
      let runtime;
      try {
        runtime = await loadPdfjs();
      } catch (err) {
        throw new Error(`Die PDF-Bibliothek konnte nicht geladen werden (${err.message || err}).`);
      }
      if (gen !== this._gen) return { ok: false, cancelled: true };
      this._lib = runtime.lib;
      const task = runtime.lib.getDocument({
        url,
        worker: runtime.worker,
        cMapUrl: `${PDFJS_BASE}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS_BASE}standard_fonts/`,
        // Fetch on demand: a 68 MB service manual should not download in full.
        disableStream: true,
        disableAutoFetch: true,
        rangeChunkSize: RANGE_CHUNK_BYTES,
        // Scanned schematics embed ~55 MP page images (220 MB decoded each).
        // Canvases never exceed MAX_CANVAS_PIXELS, so shrink them to match.
        canvasMaxAreaInBytes: MAX_CANVAS_PIXELS * 4,
        isEvalSupported: false,
      });
      this._task = task;
      task.onProgress = ({ loaded, total }) => {
        if (gen !== this._gen || this._doc || !total) return;
        this._showMessage(`PDF wird geladen … ${Math.min(100, Math.round((loaded / total) * 100))} %`);
      };
      const doc = await task.promise;
      if (gen !== this._gen) return { ok: false, cancelled: true };
      this._doc = doc;
      this._numPages = doc.numPages;
      this._tops = new Float64Array(doc.numPages + 2);
      const first = await this._ensurePage(clamp(page, 1, doc.numPages));
      if (gen !== this._gen) return { ok: false, cancelled: true };
      const vp = first.getViewport({ scale: 1 });
      this._defaultSize = { w: vp.width, h: vp.height };
      this._pageTotal.textContent = `/ ${doc.numPages}`;
      this._hideMessage();
      this._page = clamp(page, 1, doc.numPages);
      this._relayout();
      this._fitWidth();
      this._scrollToPageTop(this._page);
      this._update();
      settle(true);
      if (term) this.search(term);
      return { ok: true, pages: doc.numPages };
    } catch (err) {
      if (gen !== this._gen) return { ok: false, cancelled: true };
      const message = describeLoadError(err);
      this._showMessage(`PDF konnte nicht geladen werden. ${message}`, true);
      this._opts.notify?.(`PDF konnte nicht geladen werden: ${message}`);
      settle(false);
      return { ok: false, error: message };
    }
  }

  close() {
    this._teardownDocument();
    this._titleEl.textContent = '';
    this._searchInput.value = '';
    this._term = '';
    this._setCount('');
    this._showMessage('Kein PDF geöffnet.');
  }

  dispose() {
    this._teardownDocument();
    this._ac.abort();
    this._resizeObserver.disconnect();
    clearTimeout(this._searchDebounce);
    clearTimeout(this._zoomDebounce);
    this.root.remove();
  }

  _teardownDocument() {
    this._gen += 1;
    this._searchGen += 1;
    for (const slot of [...this._slots.values()]) this._unmount(slot);
    if (this._task) this._task.destroy().catch(() => {});
    this._task = null;
    this._doc = null;
    this._resetDocumentState();
    this._pagesEl.style.width = '0';
    this._pagesEl.style.height = '0';
    this._pageInput.value = '–';
    this._pageTotal.textContent = '/ –';
    this._zoomLabel.textContent = '–';
    this._clearHover();
    this._closeMenu();
    return this._gen;
  }

  _ensurePage(n) {
    let promise = this._pages.get(n);
    if (!promise) {
      const gen = this._gen;
      promise = this._doc.getPage(n).then((page) => {
        if (gen === this._gen && !this._sizes[n]) {
          const vp = page.getViewport({ scale: 1 });
          this._sizes[n] = { w: vp.width, h: vp.height, vp };
          if (vp.width !== this._defaultSize.w || vp.height !== this._defaultSize.h) this._layoutDirty = true;
          if (this._layoutDirty) this._requestUpdate();
        }
        return page;
      });
      promise.catch(() => this._pages.delete(n));
      this._pages.set(n, promise);
    }
    return promise;
  }

  _getText(n) {
    let promise = this._textPromises.get(n);
    if (!promise) {
      const gen = this._gen;
      promise = this._ensurePage(n)
        .then((page) => page.getTextContent())
        .then((content) => {
          if (gen !== this._gen) return null;
          const pt = buildPageText(content.items, this._sizes[n].vp, this._lib.Util);
          this._texts[n] = pt;
          return pt;
        })
        .catch(() => {
          if (gen !== this._gen) return null;
          const empty = { text: '', starts: new Uint32Array(1), lens: new Uint32Array(0), geom: new Float32Array(0), count: 0 };
          this._texts[n] = empty;
          return empty;
        });
      this._textPromises.set(n, promise);
    }
    return promise;
  }

  // ------------------------------------------------------------------ layout

  _sizeOf(n) {
    return this._sizes[n] || this._defaultSize;
  }

  _relayout() {
    const n = this._numPages;
    if (!n) return;
    const s = this._scale;
    let y = PAGE_GAP;
    let maxW = 0;
    for (let i = 1; i <= n; i += 1) {
      const z = this._sizeOf(i);
      this._tops[i] = y;
      y += z.h * s + PAGE_GAP;
      if (z.w > maxW) maxW = z.w;
    }
    this._tops[n + 1] = y;
    this._contentW = Math.max(this._scroller.clientWidth, maxW * s + 2 * PAGE_GAP);
    this._pagesEl.style.width = `${this._contentW}px`;
    this._pagesEl.style.height = `${y}px`;
    for (const slot of this._slots.values()) this._placeSlot(slot);
  }

  _pageLeft(n) {
    return (this._contentW - this._sizeOf(n).w * this._scale) / 2;
  }

  _placeSlot(slot) {
    const z = this._sizeOf(slot.n);
    const { style } = slot.el;
    style.left = `${this._pageLeft(slot.n)}px`;
    style.top = `${this._tops[slot.n]}px`;
    style.width = `${z.w * this._scale}px`;
    style.height = `${z.h * this._scale}px`;
  }

  _pageAt(y) {
    let lo = 1;
    let hi = this._numPages;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this._tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  _captureAnchor(cx, cy) {
    const x = this._scroller.scrollLeft + cx;
    const y = this._scroller.scrollTop + cy;
    const n = this._pageAt(y);
    const z = this._sizeOf(n);
    return {
      n,
      cx,
      cy,
      fx: (x - this._pageLeft(n)) / (z.w * this._scale),
      fy: (y - this._tops[n]) / (z.h * this._scale),
    };
  }

  _restoreAnchor(a) {
    const z = this._sizeOf(a.n);
    this._scroller.scrollLeft = this._pageLeft(a.n) + a.fx * z.w * this._scale - a.cx;
    this._scroller.scrollTop = this._tops[a.n] + a.fy * z.h * this._scale - a.cy;
  }

  _requestUpdate() {
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = 0;
      this._update();
    });
  }

  _update() {
    if (!this._numPages) return;
    if (this._layoutDirty) {
      this._layoutDirty = false;
      const anchor = this._captureAnchor(0, 0);
      this._relayout();
      this._restoreAnchor(anchor);
    }
    const sc = this._scroller;
    const top = sc.scrollTop;
    const bottom = top + sc.clientHeight;
    const first = this._pageAt(top);
    const last = this._pageAt(bottom);
    this._visible = [first, last];
    const from = Math.max(1, first - MOUNT_OVERSCAN);
    const to = Math.min(this._numPages, last + MOUNT_OVERSCAN);
    for (const slot of [...this._slots.values()]) {
      if (slot.n < from || slot.n > to) this._unmount(slot);
    }
    for (let n = from; n <= to; n += 1) {
      if (!this._slots.has(n)) this._mount(n);
    }
    const current = this._pageAt((top + bottom) / 2);
    if (current !== this._page) {
      this._page = current;
      this._emitState();
    }
    if (this.root.ownerDocument.activeElement !== this._pageInput) {
      this._pageInput.value = String(this._page);
    }
    clearTimeout(this._pumpDebounce);
    this._pumpDebounce = setTimeout(() => this._pump(), 50);
  }

  _emitState() {
    this._opts.onState?.(this.state);
  }

  _onResize() {
    if (!this._numPages || !this._scroller.clientWidth) return;
    if (this._fit) {
      this._fitWidth();
    } else {
      const anchor = this._captureAnchor(0, 0);
      this._relayout();
      this._restoreAnchor(anchor);
    }
    this._requestUpdate();
  }

  // --------------------------------------------------------------- rendering

  _mount(n) {
    const slotEl = el('div', 'pdfp-page');
    const hl = el('div', 'pdfp-hl');
    const hover = el('div', 'pdfp-hover', { hidden: '' });
    slotEl.append(hl, hover);
    const slot = { n, el: slotEl, hl, hover, canvas: null, task: null, taskScale: 0, renderedScale: 0 };
    this._slots.set(n, slot);
    this._placeSlot(slot);
    this._pagesEl.append(slotEl);
    this._paintHits(slot);
  }

  _unmount(slot) {
    this._slots.delete(slot.n);
    if (slot.task) slot.task.cancel();
    this._releaseCanvas(slot);
    slot.el.remove();
    const promise = this._pages.get(slot.n);
    if (promise) promise.then((page) => page.cleanup()).catch(() => {});
  }

  _releaseCanvas(slot) {
    if (!slot.canvas) return;
    // Zeroing the bitmap frees it now rather than at the next GC.
    slot.canvas.width = 0;
    slot.canvas.height = 0;
    slot.canvas.remove();
    slot.canvas = null;
    slot.renderedScale = 0;
  }

  _targetRenderScale(n) {
    const z = this._sizeOf(n);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return Math.min(this._scale * dpr, Math.sqrt(MAX_CANVAS_PIXELS / (z.w * z.h)));
  }

  _needsRender(slot) {
    const want = this._targetRenderScale(slot.n);
    return !slot.renderedScale || Math.abs(slot.renderedScale - want) / want > 0.02;
  }

  _isVisible(n) {
    return !!this._visible && n >= this._visible[0] && n <= this._visible[1];
  }

  _nextToRender() {
    if (!this._visible) return null;
    const [first, last] = this._visible;
    const center = this._page;
    let best = null;
    let bestDist = Infinity;
    for (const slot of this._slots.values()) {
      if (slot.n < first - RENDER_OVERSCAN || slot.n > last + RENDER_OVERSCAN) continue;
      if (!this._needsRender(slot) || slot.failedScale === this._targetRenderScale(slot.n)) continue;
      const dist = Math.abs(slot.n - center) + (this._isVisible(slot.n) ? 0 : 1000);
      if (dist < bestDist) {
        bestDist = dist;
        best = slot;
      }
    }
    return best;
  }

  async _pump() {
    if (this._pumping) {
      this._pumpAgain = true;
      return;
    }
    const gen = this._gen;
    this._pumping = true;
    try {
      for (;;) {
        const slot = this._nextToRender();
        if (!slot || gen !== this._gen) break;
        await this._renderSlot(slot);
      }
    } finally {
      if (gen === this._gen) this._pumping = false;
    }
    if (gen === this._gen && this._pumpAgain) {
      this._pumpAgain = false;
      this._pump();
    }
  }

  _evictFor(pixels) {
    const slots = [...this._slots.values()].filter((s) => s.canvas);
    let total = slots.reduce((sum, s) => sum + s.canvas.width * s.canvas.height, 0);
    slots.sort((a, b) => Math.abs(b.n - this._page) - Math.abs(a.n - this._page));
    for (const slot of slots) {
      if (total + pixels <= MAX_TOTAL_PIXELS) return true;
      if (this._isVisible(slot.n)) continue;
      total -= slot.canvas.width * slot.canvas.height;
      this._releaseCanvas(slot);
    }
    return total + pixels <= MAX_TOTAL_PIXELS;
  }

  async _renderSlot(slot) {
    const gen = this._gen;
    let page;
    try {
      page = await this._ensurePage(slot.n);
    } catch {
      slot.failedScale = this._targetRenderScale(slot.n);
      return;
    }
    if (gen !== this._gen || this._slots.get(slot.n) !== slot) return;
    const want = this._targetRenderScale(slot.n);
    const viewport = page.getViewport({ scale: want });
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));
    if (!this._evictFor(width * height) && !this._isVisible(slot.n)) {
      slot.failedScale = want;
      return;
    }
    const canvas = el('canvas');
    canvas.width = width;
    canvas.height = height;
    const task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport });
    slot.task = task;
    slot.taskScale = want;
    try {
      await task.promise;
    } catch (err) {
      canvas.width = 0;
      canvas.height = 0;
      slot.task = null;
      if (err && err.name !== 'RenderingCancelledException') slot.failedScale = want;
      return;
    } finally {
      // Decoded images stay cached per page until cleanup; the bitmap on the
      // canvas is all that is needed from here on.
      page.cleanup();
    }
    slot.task = null;
    if (gen !== this._gen || this._slots.get(slot.n) !== slot) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    // Swap only when finished, so the previous bitmap stays visible meanwhile.
    this._releaseCanvas(slot);
    slot.canvas = canvas;
    slot.renderedScale = want;
    slot.el.prepend(canvas);
    this._getText(slot.n).then(() => {
      if (this._slots.get(slot.n) === slot) this._paintHits(slot);
    });
  }

  // -------------------------------------------------------------- navigation

  _setScale(next, { cx, cy, fit = false } = {}) {
    if (!this._numPages) return;
    const scale = clamp(next, MIN_SCALE, MAX_SCALE);
    this._fit = fit;
    this._zoomLabel.textContent = `${Math.round(scale * 100)} %`;
    if (Math.abs(scale - this._scale) < 1e-4) return;
    const sc = this._scroller;
    const anchor = this._captureAnchor(cx ?? sc.clientWidth / 2, cy ?? sc.clientHeight / 2);
    this._scale = scale;
    this._relayout();
    this._restoreAnchor(anchor);
    // Existing bitmaps stretch with CSS until the zoom gesture settles.
    for (const slot of this._slots.values()) {
      if (slot.task && Math.abs(slot.taskScale - this._targetRenderScale(slot.n)) / slot.taskScale > 0.02) slot.task.cancel();
    }
    this._requestUpdate();
    clearTimeout(this._zoomDebounce);
    this._zoomDebounce = setTimeout(() => this._pump(), 180);
  }

  _zoomBy(factor, at) {
    this._setScale(this._scale * factor, at);
  }

  _fitWidth() {
    const avail = this._scroller.clientWidth - 2 * PAGE_GAP;
    if (avail <= 0 || !this._numPages) return;
    this._setScale(avail / this._sizeOf(this._page).w, { fit: true });
  }

  _scrollToPageTop(n) {
    this._scroller.scrollTop = this._tops[n] - PAGE_GAP / 2;
  }

  async _gotoPage(n) {
    if (!this._doc) return;
    const gen = this._gen;
    await this._ensurePage(n).catch(() => {});
    if (gen !== this._gen) return;
    this._flushLayout();
    this._scrollToPageTop(n);
    this._update();
  }

  _flushLayout() {
    if (!this._layoutDirty) return;
    this._layoutDirty = false;
    const anchor = this._captureAnchor(0, 0);
    this._relayout();
    this._restoreAnchor(anchor);
  }

  // ----------------------------------------------------------------- pointer

  _onWheel(e) {
    if (!this._numPages) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (e.shiftKey) {
      this._scroller.scrollTop += (e.deltaY || e.deltaX) * unit;
      return;
    }
    const rect = this._scroller.getBoundingClientRect();
    const delta = clamp(e.deltaY * unit, -240, 240);
    this._zoomBy(Math.exp(-delta * (e.ctrlKey ? 0.006 : 0.0018)), {
      cx: e.clientX - rect.left,
      cy: e.clientY - rect.top,
    });
  }

  _onPointerDown(e) {
    this._closeMenu();
    if (e.button !== 0 || !this._numPages) return;
    const rect = this._scroller.getBoundingClientRect();
    const onScrollbar = e.clientX - rect.left >= this._scroller.clientWidth || e.clientY - rect.top >= this._scroller.clientHeight;
    if (onScrollbar) return;
    this.root.focus({ preventScroll: true });
    this._drag = {
      x: e.clientX,
      y: e.clientY,
      left: this._scroller.scrollLeft,
      top: this._scroller.scrollTop,
      moved: false,
      // Touch keeps native scrolling; the pointer is only tracked for taps.
      pan: e.pointerType !== 'touch',
    };
    if (this._drag.pan) {
      this._scroller.setPointerCapture(e.pointerId);
      this._scroller.classList.add('dragging');
    }
  }

  _onPointerMove(e) {
    const drag = this._drag;
    if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.pan && drag.moved) {
        this._scroller.scrollLeft = drag.left - dx;
        this._scroller.scrollTop = drag.top - dy;
        this._clearHover();
      }
      return;
    }
    if (e.pointerType === 'mouse') this._queueHover(e.clientX, e.clientY);
  }

  _onPointerUp(e) {
    const drag = this._drag;
    this._drag = null;
    this._scroller.classList.remove('dragging');
    if (!drag || drag.moved) return;
    this._hitToken(e.clientX, e.clientY).then((hit) => {
      if (hit) this._opts.onTermClick?.(hit.token);
    });
  }

  _onTouchStart(e) {
    this._pinch = e.touches.length === 2
      ? { dist: this._touchDist(e.touches), scale: this._scale }
      : null;
  }

  _onTouchMove(e) {
    if (!this._pinch || e.touches.length !== 2) return;
    e.preventDefault();
    if (this._drag) this._drag.moved = true;
    const rect = this._scroller.getBoundingClientRect();
    this._setScale(this._pinch.scale * (this._touchDist(e.touches) / this._pinch.dist), {
      cx: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
      cy: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top,
    });
  }

  _touchDist(touches) {
    return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY) || 1;
  }

  _locate(clientX, clientY) {
    if (!this._numPages) return null;
    const rect = this._scroller.getBoundingClientRect();
    const x = this._scroller.scrollLeft + clientX - rect.left;
    const y = this._scroller.scrollTop + clientY - rect.top;
    const n = this._pageAt(y);
    const z = this._sizeOf(n);
    const px = (x - this._pageLeft(n)) / this._scale;
    const py = (y - this._tops[n]) / this._scale;
    if (px < 0 || py < 0 || px > z.w || py > z.h) return null;
    return { n, px, py };
  }

  async _hitToken(clientX, clientY) {
    const loc = this._locate(clientX, clientY);
    if (!loc) return null;
    const pt = await this._getText(loc.n);
    if (!pt) return null;
    const hit = tokenAt(pt, loc.px, loc.py);
    return hit ? { ...hit, n: loc.n, pt } : null;
  }

  _queueHover(x, y) {
    this._hoverAt = [x, y];
    if (this._hoverFrame) return;
    this._hoverFrame = requestAnimationFrame(() => {
      this._hoverFrame = 0;
      this._applyHover();
    });
  }

  _applyHover() {
    if (!this._hoverAt || this._drag) return;
    const loc = this._locate(...this._hoverAt);
    const pt = loc && this._texts[loc.n];
    const hit = pt ? tokenAt(pt, loc.px, loc.py) : null;
    const slot = hit && this._slots.get(loc.n);
    if (!slot) {
      this._clearHover(true);
      return;
    }
    if (this._hoverSlot && this._hoverSlot !== slot) this._hoverSlot.hover.hidden = true;
    this._hoverSlot = slot;
    const [x0, y0, x1, y1] = unionRects(rangeRects(pt, hit.start, hit.end));
    this._applyBox(slot.hover, loc.n, x0, y0, x1, y1);
    slot.hover.hidden = false;
    this._scroller.classList.add('on-token');
  }

  _clearHover(keepPosition) {
    if (!keepPosition) this._hoverAt = null;
    if (this._hoverSlot) this._hoverSlot.hover.hidden = true;
    this._hoverSlot = null;
    this._scroller?.classList.remove('on-token');
  }

  _applyBox(node, n, x0, y0, x1, y1) {
    // Percentages keep boxes aligned during CSS-only zoom.
    const z = this._sizeOf(n);
    const { style } = node;
    style.left = `${(x0 / z.w) * 100}%`;
    style.top = `${(y0 / z.h) * 100}%`;
    style.width = `${((x1 - x0) / z.w) * 100}%`;
    style.height = `${((y1 - y0) / z.h) * 100}%`;
  }

  async _onContextMenu(e) {
    e.preventDefault();
    const { clientX, clientY } = e;
    const hit = await this._hitToken(clientX, clientY);
    this._openMenu(clientX, clientY, hit && hit.token);
  }

  _openMenu(clientX, clientY, token) {
    const menu = this._menu;
    menu.replaceChildren();
    const action = el('button', 'pdfp-menu-item', { type: 'button', role: 'menuitem' });
    action.textContent = 'Auf dem Board suchen';
    if (token) {
      const head = el('div', 'pdfp-menu-head pdfp-mono');
      head.textContent = token;
      menu.append(head);
      action.addEventListener('click', () => {
        this._closeMenu();
        this._opts.onTermClick?.(token);
      });
    } else {
      action.disabled = true;
      action.title = 'An dieser Stelle wurde kein Text erkannt.';
    }
    menu.append(action);
    menu.hidden = false;
    const rect = this.root.getBoundingClientRect();
    menu.style.left = `${Math.min(clientX - rect.left, rect.width - menu.offsetWidth - 4)}px`;
    menu.style.top = `${Math.min(clientY - rect.top, rect.height - menu.offsetHeight - 4)}px`;
    if (token) action.focus({ preventScroll: true });
  }

  _closeMenu() {
    if (this._menu) this._menu.hidden = true;
  }

  _onKey(e) {
    const inField = e.target instanceof HTMLInputElement;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      this._searchInput.focus();
      this._searchInput.select();
      return;
    }
    if (e.key === 'F3') {
      e.preventDefault();
      if (e.shiftKey) this.previous();
      else this.next();
      return;
    }
    if (inField || e.ctrlKey || e.metaKey || e.altKey || !this._numPages) return;
    const sc = this._scroller;
    const actions = {
      ArrowDown: () => { sc.scrollTop += 60; },
      ArrowUp: () => { sc.scrollTop -= 60; },
      ArrowRight: () => { sc.scrollLeft += 60; },
      ArrowLeft: () => { sc.scrollLeft -= 60; },
      PageDown: () => this._gotoPage(Math.min(this._numPages, this._page + 1)),
      PageUp: () => this._gotoPage(Math.max(1, this._page - 1)),
      Home: () => this._gotoPage(1),
      End: () => this._gotoPage(this._numPages),
      '+': () => this._zoomBy(1.25),
      '=': () => this._zoomBy(1.25),
      '-': () => this._zoomBy(0.8),
      0: () => this._fitWidth(),
      Escape: () => this._closeMenu(),
    };
    const action = actions[e.key];
    if (!action) return;
    e.preventDefault();
    action();
  }

  // ------------------------------------------------------------------ search

  /** Resolves with {hits, mode: 'token'|'substring'|'none', cancelled?, capped?}. */
  async search(rawTerm) {
    const gen = (this._searchGen += 1);
    const docGen = this._gen;
    const term = String(rawTerm ?? '').trim().replace(/\s+/g, ' ');
    if (this._searchInput.value.trim() !== term) this._searchInput.value = term;
    this._term = term;
    this._clearHits();
    this._emitState();
    if (!term) {
      this._setCount('');
      return { hits: 0, mode: 'none' };
    }
    this._setCount('Suche …');
    const loaded = await this._ready;
    if (gen !== this._searchGen) return { hits: 0, mode: 'none', cancelled: true };
    if (!loaded || !this._numPages) {
      this._setCount('');
      return { hits: 0, mode: 'none' };
    }
    const needle = foldCase(term);
    const fallback = [];
    let capped = false;
    let lastYield = performance.now();
    for (let n = 1; n <= this._numPages; n += 1) {
      const pt = this._texts[n] || await this._getText(n);
      if (gen !== this._searchGen || docGen !== this._gen) return { hits: 0, mode: 'none', cancelled: true };
      if (!pt) continue;
      const sink = { token: [], substring: [] };
      findMatches(foldCase(pt.text), needle, !this._hits.length, sink);
      if (sink.token.length) this._appendHits(n, sink.token, needle.length);
      else if (!this._hits.length) for (const at of sink.substring) fallback.push({ page: n, start: at, end: at + needle.length });
      if (this._hits.length >= MAX_SEARCH_HITS) {
        capped = true;
        break;
      }
      this._hitMode = this._hits.length ? 'token' : 'none';
      if (n % 4 === 0 || n === this._numPages) this._renderCount(n);
      // Cached pages resolve without ever yielding; keep the UI responsive.
      if (performance.now() - lastYield > 24) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
        if (gen !== this._searchGen || docGen !== this._gen) return { hits: 0, mode: 'none', cancelled: true };
      }
    }
    if (!this._hits.length && fallback.length) {
      const limited = fallback.slice(0, MAX_SEARCH_HITS);
      capped = fallback.length > MAX_SEARCH_HITS;
      for (const hit of limited) this._addHit(hit);
      this._hitMode = 'substring';
      this._repaintMountedHits();
      this._gotoHit(0);
    } else {
      this._hitMode = this._hits.length ? 'token' : 'none';
    }
    this._renderCount(this._numPages);
    return capped
      ? { hits: this._hits.length, mode: this._hitMode, capped: true }
      : { hits: this._hits.length, mode: this._hitMode };
  }

  _clearHits() {
    this._hits = [];
    this._hitsByPage = new Map();
    this._hitIdx = -1;
    this._hitMode = 'none';
    this._repaintMountedHits();
  }

  _addHit(hit) {
    const index = this._hits.push(hit) - 1;
    let list = this._hitsByPage.get(hit.page);
    if (!list) this._hitsByPage.set(hit.page, (list = []));
    list.push(index);
  }

  _appendHits(n, offsets, length) {
    const hadNone = !this._hits.length;
    for (const at of offsets) this._addHit({ page: n, start: at, end: at + length });
    const slot = this._slots.get(n);
    if (slot) this._paintHits(slot);
    if (hadNone) {
      this._hitMode = 'token';
      this._gotoHit(0);
    }
  }

  _repaintMountedHits() {
    for (const slot of this._slots.values()) this._paintHits(slot);
  }

  _paintHits(slot) {
    slot.hl.replaceChildren();
    const list = this._hitsByPage.get(slot.n);
    const pt = this._texts[slot.n];
    if (!list || !pt) return;
    const frag = document.createDocumentFragment();
    for (const index of list) {
      const hit = this._hits[index];
      for (const [x0, y0, x1, y1] of rangeRects(pt, hit.start, hit.end)) {
        const box = el('div', index === this._hitIdx ? 'pdfp-hit current' : 'pdfp-hit');
        this._applyBox(box, slot.n, x0, y0, x1, y1);
        frag.append(box);
      }
    }
    slot.hl.append(frag);
  }

  next() {
    this._step(1);
  }

  previous() {
    this._step(-1);
  }

  _step(direction) {
    const total = this._hits.length;
    if (!total) return;
    this._gotoHit((this._hitIdx + direction + total) % total);
  }

  async _gotoHit(index) {
    const hit = this._hits[index];
    if (!hit) return;
    const previousPage = this._hits[this._hitIdx]?.page;
    this._hitIdx = index;
    this._renderCount(this._numPages);
    for (const n of new Set([previousPage, hit.page])) {
      const slot = this._slots.get(n);
      if (slot) this._paintHits(slot);
    }
    const gen = this._gen;
    await this._ensurePage(hit.page).catch(() => {});
    if (gen !== this._gen || this._hitIdx !== index) return;
    this._flushLayout();
    const pt = this._texts[hit.page];
    if (!pt) return;
    const [x0, y0, x1, y1] = unionRects(rangeRects(pt, hit.start, hit.end));
    const s = this._scale;
    const sc = this._scroller;
    const x = this._pageLeft(hit.page) + ((x0 + x1) / 2) * s;
    const y = this._tops[hit.page] + ((y0 + y1) / 2) * s;
    const margin = 40;
    const inView = x > sc.scrollLeft + margin && x < sc.scrollLeft + sc.clientWidth - margin
      && y > sc.scrollTop + margin && y < sc.scrollTop + sc.clientHeight - margin;
    if (!inView) {
      sc.scrollLeft = x - sc.clientWidth / 2;
      sc.scrollTop = y - sc.clientHeight / 2;
    }
    this._update();
  }

  _renderCount(scanned) {
    const total = this._hits.length;
    let text;
    if (!total) {
      text = scanned < this._numPages ? `Suche … ${scanned}/${this._numPages}` : 'Keine Treffer';
    } else {
      const position = this._hitIdx >= 0 ? this._hitIdx + 1 : 0;
      text = `${position} / ${total}${scanned < this._numPages ? '+' : ''}`;
      if (this._hitMode === 'substring') text += ' · Teil';
    }
    this._setCount(text);
  }

  _setCount(text) {
    this._countEl.textContent = text;
  }

  // ---------------------------------------------------------------- settings

  setNight(value, { silent = false } = {}) {
    this._night = !!value;
    this.root.classList.toggle('night', this._night);
    this._nightBtn.setAttribute('aria-pressed', String(this._night));
    this._nightBtn.classList.toggle('active', this._night);
    if (!silent) {
      writePref(NIGHT_KEY, this._night);
      this._opts.onNight?.(this._night);
    }
  }

  _showMessage(text, isError = false) {
    this._msgEl.textContent = text;
    this._msgEl.classList.toggle('error', isError);
    this._msgEl.hidden = false;
  }

  _hideMessage() {
    this._msgEl.hidden = true;
  }
}

function unionRects(rects) {
  if (!rects.length) return [0, 0, 0, 0];
  return rects.reduce((u, r) => [
    Math.min(u[0], r[0]),
    Math.min(u[1], r[1]),
    Math.max(u[2], r[2]),
    Math.max(u[3], r[3]),
  ]);
}

export class PdfPanel {
  constructor(container, { onTermClick, notify } = {}) {
    this._onTermClick = onTermClick;
    this._notify = notify;
    this._host = el('div', 'pdfp-host');
    container.append(this._host);
    this._view = new PdfView(this._host, {
      onTermClick: (token) => this._onTermClick?.(token),
      notify: (text) => this._notify?.(text),
      detach: { icon: ICONS.popout, label: 'In eigenem Fenster öffnen', onClick: () => this.popout() },
    });
    this._note = this._buildPoppedNote();
    this._host.append(this._note);

    this._session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this._channel = null;
    this._win = null;
    this._popped = false;
    this._peerReady = false;
    this._queue = [];
    this._pending = new Map();
    this._nextId = 1;
    this._current = null;
    this._remoteState = { page: 1, term: '' };
    this._disposed = false;
    this._ac = new AbortController();
    window.addEventListener('pagehide', () => this._closeWindowForUnload(), { signal: this._ac.signal });
  }

  get isPopped() {
    return this._popped;
  }

  /** Resolves with {ok, pages} or {ok: false, error}; failures show in the panel. */
  async open({ url, title }) {
    this._current = { url: new URL(url, window.location.href).href, title: title || '' };
    this._remoteState = { page: 1, term: '' };
    // Must run before the first await: popups need the caller's user gesture.
    if (!this._popped && readPref(POPPED_KEY)) this._openWindow();
    if (this._popped) return this._request('open', { ...this._current, page: 1, term: '' });
    return this._view.open(this._current);
  }

  /** Resolves with {hits, mode, cancelled?}. Works docked and detached. */
  async search(term) {
    if (this._popped) return this._request('search', { term: String(term ?? '') });
    return this._view.search(term);
  }

  next() {
    if (this._popped) this._send('next');
    else this._view.next();
  }

  previous() {
    if (this._popped) this._send('previous');
    else this._view.previous();
  }

  setNight(value) {
    this._view.setNight(value);
    if (this._popped) this._send('night', { value: !!value });
  }

  /** Moves the open document to a detached window. Returns false if it could not. */
  popout() {
    if (this._popped) {
      this._win?.focus();
      return true;
    }
    if (!this._current) return false;
    const { page, term } = this._view.state;
    this._remoteState = { page, term };
    return this._openWindow();
  }

  /** Closes the detached window and shows the document in the panel again. */
  dock() {
    if (!this._popped) return;
    this._send('close');
    try {
      this._win?.close();
    } catch {
      // the window is already gone
    }
    this._redock();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._closeWindowForUnload();
    this._teardownLink();
    this._ac.abort();
    this._view.dispose();
    this._host.remove();
  }

  // ------------------------------------------------------------ window link

  _openWindow() {
    if (typeof BroadcastChannel !== 'function') {
      this._notify?.('Separate Fenster werden von diesem Browser nicht unterstützt.');
      return false;
    }
    const url = new URL('../pdf_popout.html', import.meta.url);
    url.searchParams.set('s', this._session);
    let win = null;
    try {
      win = window.open(url.href, `wb-pdf-${this._session}`, 'popup=yes,width=1180,height=860');
    } catch {
      win = null;
    }
    if (!win) {
      writePref(POPPED_KEY, false);
      this._notify?.('Das Popup wurde blockiert. Das PDF bleibt angedockt.');
      return false;
    }
    this._win = win;
    this._popped = true;
    this._peerReady = false;
    this._channel = new BroadcastChannel(PDF_CHANNEL);
    this._channel.onmessage = (e) => this._onMessage(e.data);
    writePref(POPPED_KEY, true);
    this._view.close();
    this._note.hidden = false;
    this._view.root.hidden = true;
    this._pollTimer = setInterval(() => {
      if (!this._win || this._win.closed) this._redock();
    }, 800);
    this._readyTimer = setTimeout(() => {
      if (this._peerReady) return;
      this._notify?.('Das separate Fenster antwortet nicht. Das PDF wird wieder angedockt.');
      this.dock();
    }, POPOUT_READY_TIMEOUT_MS);
    return true;
  }

  _post(type, payload) {
    this._channel?.postMessage({ type, session: this._session, ...payload });
  }

  _send(type, payload = {}) {
    if (this._peerReady) this._post(type, payload);
    else this._queue.push({ type, payload });
  }

  _request(type, payload) {
    return new Promise((resolve) => {
      const id = this._nextId;
      this._nextId += 1;
      this._pending.set(id, resolve);
      this._send(type, { ...payload, id });
    });
  }

  _settlePending() {
    for (const resolve of this._pending.values()) resolve({ ok: false, hits: 0, mode: 'none', cancelled: true });
    this._pending.clear();
  }

  _onMessage(msg) {
    if (!msg || msg.session !== this._session || !this._popped) return;
    switch (msg.type) {
      case 'ready':
        this._onPeerReady();
        break;
      case 'reply': {
        const resolve = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        resolve?.(msg.result);
        break;
      }
      case 'termClick':
        this._onTermClick?.(msg.token);
        break;
      case 'state':
        this._remoteState = { page: msg.page, term: msg.term };
        break;
      case 'night':
        this._view.setNight(msg.value, { silent: true });
        break;
      case 'notify':
        this._notify?.(msg.text);
        break;
      case 'closed':
        // A page reload also fires this; only a really closed window re-docks.
        setTimeout(() => {
          if (this._popped && (!this._win || this._win.closed)) this._redock();
        }, 200);
        break;
      default:
        break;
    }
  }

  _onPeerReady() {
    this._peerReady = true;
    clearTimeout(this._readyTimer);
    this._post('night', { value: this._view.night });
    const queued = this._queue;
    this._queue = [];
    if (this._current && !queued.some((m) => m.type === 'open')) {
      this._post('open', { ...this._current, ...this._remoteState });
    }
    for (const { type, payload } of queued) this._post(type, payload);
  }

  _teardownLink() {
    clearInterval(this._pollTimer);
    clearTimeout(this._readyTimer);
    this._settlePending();
    this._channel?.close();
    this._channel = null;
    this._win = null;
    this._popped = false;
    this._peerReady = false;
    this._queue = [];
  }

  _redock() {
    if (!this._popped) return;
    const state = this._remoteState;
    this._teardownLink();
    writePref(POPPED_KEY, false);
    this._note.hidden = true;
    this._view.root.hidden = false;
    if (this._current) this._view.open({ ...this._current, page: state.page, term: state.term });
  }

  _closeWindowForUnload() {
    if (this._popped) this._post('close');
  }

  _buildPoppedNote() {
    const note = el('div', 'pdfp-popped', { hidden: '' });
    const text = el('p');
    text.textContent = 'Das PDF ist in einem eigenen Fenster geöffnet.';
    const button = el('button', 'pdfp-popped-btn', { type: 'button' });
    button.innerHTML = `${ICONS.dock}<span>Wieder andocken</span>`;
    button.addEventListener('click', () => this.dock());
    note.append(text, button);
    return note;
  }
}

export const POPOUT_DOCK_ICON = ICONS.dock;
