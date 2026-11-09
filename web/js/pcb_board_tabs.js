// Tab strip for several open boards. Keeps at most `maxLoaded` board JSONs in
// memory; older tabs stay in the strip and reload through `loadBoard(id)`.

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_MAX_LOADED = 8;

export function closeIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M3 3l6 6M9 3l-6 6');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  svg.append(path);
  return svg;
}

export class BoardTabs {
  /**
   * @param {HTMLElement} container Empty element that becomes the tab strip.
   * @param {object} options
   * @param {(tab) => void} options.onActivate Called once `tab.board` is loaded.
   * @param {(tab) => void} options.onClose Called after the tab left the strip.
   * @param {(id) => Promise} [options.loadBoard] Resolves to a board or `{board, metadata}`.
   *   Without it nothing can be reloaded, so nothing is evicted.
   * @param {() => object} [options.getView] Reads the viewer state of the outgoing tab.
   * @param {(tab, error) => void} [options.onError] A board failed to load.
   * @param {number} [options.maxLoaded] Board JSONs kept in memory, default 8.
   */
  constructor(container, { onActivate, onClose, loadBoard, getView, onError, maxLoaded = DEFAULT_MAX_LOADED } = {}) {
    this.container = container;
    this.onActivate = onActivate;
    this.onClose = onClose;
    this.loadBoard = loadBoard;
    this.getView = getView;
    this.onError = onError;
    this.maxLoaded = maxLoaded;
    this._tabs = new Map();
    this._elements = new Map();
    this._pending = new Map();
    this._activeId = null;
    this._shownId = null; // The tab whose board the viewer really displays.
    this._activation = 0;
    this._clock = 0;
    this._events = new AbortController();
    container.classList.add('pbt-strip');
    container.setAttribute('role', 'tablist');
    container.setAttribute('aria-label', 'Geöffnete Platinen');
    container.addEventListener('wheel', event => this._onWheel(event),
      { passive: false, signal: this._events.signal });
    container.addEventListener('keydown', event => this._onStripKey(event),
      { signal: this._events.signal });
  }

  get active() { return this._tabs.get(this._activeId) ?? null; }

  get all() { return [...this._tabs.values()]; }

  /** Open a board in a new tab, or update and activate its existing tab. */
  open({ id, title, board = null, metadata = null }) {
    let tab = this._tabs.get(id);
    const replacedBoard = Boolean(tab && board && tab.board !== board);
    if (tab) {
      if (title !== undefined) tab.title = title;
      if (metadata) tab.metadata = metadata;
      if (board) tab.board = board;
    } else {
      tab = { id, title: title ?? String(id), board, metadata, view: null, loading: false, error: null, lastUsed: 0 };
      this._tabs.set(id, tab);
      this._elements.set(id, this._createElement(tab));
    }
    if (replacedBoard && this._shownId === id) this._shownId = null;
    return this.activate(id);
  }

  /** Switch to a tab, loading its board first if it was evicted. Resolves to the tab, or null. */
  async activate(id) {
    const tab = this._tabs.get(id);
    if (!tab) return null;
    tab.lastUsed = ++this._clock;
    if (id === this._activeId && id === this._shownId && tab.board) {
      this._sync();
      this._scrollIntoView(tab);
      return tab;
    }
    const activation = ++this._activation;
    this._activeId = id;
    tab.error = null;
    this._sync();
    this._scrollIntoView(tab);
    const board = tab.board ?? await this._load(tab);
    if (activation !== this._activation || this._tabs.get(id) !== tab) return null;
    if (!board) {
      this._activeId = this._tabs.has(this._shownId) ? this._shownId : null;
      this._sync();
      return null;
    }
    this._commit(tab);
    return tab;
  }

  /** Close a tab; a closed active tab hands over to its right or left neighbour. */
  close(id) {
    const tab = this._tabs.get(id);
    if (!tab) return;
    const order = [...this._tabs.keys()];
    const position = order.indexOf(id);
    const wasActive = this._activeId === id;
    const next = wasActive ? order[position + 1] ?? order[position - 1] ?? null : null;
    this._tabs.delete(id);
    this._elements.get(id)?.wrapper.remove();
    this._elements.delete(id);
    if (this._shownId === id) this._shownId = null;
    if (wasActive) {
      this._activeId = null;
      this._activation += 1;
    }
    this.onClose?.(tab);
    tab.board = null;
    this._sync();
    if (next !== null) this.activate(next);
  }

  /** Store the opaque `viewer.getView()` state; it survives eviction. */
  rememberView(id, view) {
    const tab = this._tabs.get(id);
    if (tab) tab.view = view;
  }

  /** Resolve a tab's board, reloading it if evicted. Null when it cannot be loaded. */
  ensureBoard(id) {
    const tab = this._tabs.get(id);
    if (!tab) return Promise.resolve(null);
    tab.lastUsed = ++this._clock;
    return tab.board ? Promise.resolve(tab.board) : this._load(tab);
  }

  /** Move `delta` tabs along the strip, wrapping at the ends. */
  cycle(delta = 1) {
    const order = [...this._tabs.keys()];
    if (!order.length) return Promise.resolve(null);
    const current = Math.max(0, order.indexOf(this._activeId));
    return this.activate(order[(current + delta + order.length * Math.abs(delta)) % order.length]);
  }

  /**
   * Handle a keydown; returns true when it was a tab shortcut.
   * Ctrl+Tab / Ctrl+Shift+Tab, plus Alt+] / Alt+[ and Alt+1…9 / Alt+W for
   * browsers that reserve the Ctrl+Tab family.
   */
  handleKeydown(event) {
    const cycleBy = event.ctrlKey && event.key === 'Tab' ? (event.shiftKey ? -1 : 1)
      : event.altKey && event.code === 'BracketRight' ? 1
      : event.altKey && event.code === 'BracketLeft' ? -1 : 0;
    if (cycleBy) {
      event.preventDefault();
      this.cycle(cycleBy);
      return true;
    }
    if (event.altKey && /^Digit[1-9]$/.test(event.code)) {
      const tab = this.all[Number(event.code.slice(5)) - 1];
      if (!tab) return false;
      event.preventDefault();
      this.activate(tab.id);
      return true;
    }
    if (event.altKey && event.code === 'KeyW' && this._activeId !== null) {
      event.preventDefault();
      this.close(this._activeId);
      return true;
    }
    return false;
  }

  /** Bind `handleKeydown` to `target`; returns the unbind function. */
  bindKeys(target = document) {
    const handler = event => this.handleKeydown(event);
    target.addEventListener('keydown', handler, { signal: this._events.signal });
    return () => target.removeEventListener('keydown', handler);
  }

  destroy() {
    this._events.abort();
    this._activation += 1;
    this._tabs.clear();
    this._elements.clear();
    this.container.replaceChildren();
  }

  _commit(tab) {
    const outgoing = this._tabs.get(this._shownId);
    if (outgoing && outgoing !== tab && outgoing.board && this.getView) outgoing.view = this.getView();
    this._shownId = tab.id;
    tab.error = null;
    this._evict();
    this._sync();
    this.onActivate?.(tab);
  }

  _load(tab) {
    if (this._pending.has(tab.id)) return this._pending.get(tab.id);
    if (typeof this.loadBoard !== 'function') {
      tab.error = new Error('Kein Lader für diese Platine vorhanden.');
      this._sync();
      return Promise.resolve(null);
    }
    tab.loading = true;
    this._sync();
    const pending = Promise.resolve()
      .then(() => this.loadBoard(tab.id))
      .then(result => {
        if (this._tabs.get(tab.id) !== tab) return null;
        const board = result?.board ?? result;
        if (!board) throw new Error('Der Server hat keine Platine geliefert.');
        tab.board = board;
        if (result?.metadata) tab.metadata = result.metadata;
        tab.error = null;
        this._evict();
        return board;
      })
      .catch(error => {
        tab.error = error;
        if (this._tabs.get(tab.id) === tab) this.onError?.(tab, error);
        return null;
      })
      .finally(() => {
        tab.loading = false;
        this._pending.delete(tab.id);
        this._sync();
      });
    this._pending.set(tab.id, pending);
    return pending;
  }

  _evict() {
    if (typeof this.loadBoard !== 'function') return;
    const candidates = this.all
      .filter(tab => tab.board && tab.id !== this._activeId && tab.id !== this._shownId)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    let loaded = this.all.filter(tab => tab.board).length;
    for (const tab of candidates) {
      if (loaded <= this.maxLoaded) break;
      tab.board = null;
      loaded -= 1;
    }
  }

  _createElement(tab) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pbt-tab';
    wrapper.setAttribute('role', 'presentation');
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'pbt-label';
    label.setAttribute('role', 'tab');
    const status = document.createElement('span');
    status.className = 'pbt-status';
    status.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span');
    title.className = 'pbt-title';
    label.append(status, title);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'pbt-close';
    close.tabIndex = -1;
    close.setAttribute('aria-label', 'Tab schließen');
    close.title = 'Tab schließen';
    close.append(closeIcon());
    wrapper.append(label, close);
    label.addEventListener('click', () => this.activate(tab.id));
    close.addEventListener('click', event => {
      event.stopPropagation();
      this.close(tab.id);
    });
    // Suppress the browser's middle-button autoscroll, then close on release.
    wrapper.addEventListener('mousedown', event => { if (event.button === 1) event.preventDefault(); });
    wrapper.addEventListener('auxclick', event => {
      if (event.button !== 1) return;
      event.preventDefault();
      this.close(tab.id);
    });
    this.container.append(wrapper);
    return { wrapper, label, title };
  }

  _sync() {
    for (const tab of this._tabs.values()) {
      const element = this._elements.get(tab.id);
      if (!element) continue;
      const active = tab.id === this._activeId;
      element.title.textContent = tab.title;
      element.wrapper.classList.toggle('active', active);
      element.wrapper.classList.toggle('loading', tab.loading);
      element.wrapper.classList.toggle('evicted', !tab.board && !tab.loading && !tab.error);
      element.wrapper.classList.toggle('failed', Boolean(tab.error));
      element.label.setAttribute('aria-selected', String(active));
      element.label.tabIndex = active || (this._activeId === null && tab === this.all[0]) ? 0 : -1;
      element.label.title = tab.error ? `${tab.title} — Laden fehlgeschlagen, klicken zum Wiederholen`
        : !tab.board && !tab.loading ? `${tab.title} — wird beim Öffnen neu geladen` : tab.title;
    }
  }

  _scrollIntoView(tab) {
    this._elements.get(tab.id)?.wrapper.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  _onWheel(event) {
    const strip = this.container;
    if (event.deltaX || !event.deltaY || strip.scrollWidth <= strip.clientWidth) return;
    event.preventDefault();
    strip.scrollLeft += event.deltaY;
  }

  _onStripKey(event) {
    const labels = this.all.map(tab => this._elements.get(tab.id)?.label);
    const position = labels.indexOf(document.activeElement);
    if (position < 0) return;
    const count = labels.length;
    const target = event.key === 'ArrowRight' ? (position + 1) % count
      : event.key === 'ArrowLeft' ? (position - 1 + count) % count
      : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null;
    if (target !== null) {
      event.preventDefault();
      labels[target].focus();
    } else if (event.key === 'Delete') {
      event.preventDefault();
      const tab = this.all[position];
      this.close(tab.id);
      const remaining = this.all;
      if (remaining.length) this._elements.get(remaining[Math.min(position, remaining.length - 1)].id)?.label.focus();
    }
  }
}
