/** Per-board repair list: rendering, keyboard-friendly editing and server sync. */

const SAVE_DELAY_MS = 500;
const MAX_ITEMS = 2000;
const NOTE_MAX_LENGTH = 2000;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Falls back to the English literal when i18n is absent or dictionaries aren't loaded.
const tr = (key, fallback, params) => {
  const translate = window.i18n?.t ?? window.t;
  const text = typeof translate === 'function' ? translate(key, params) : key;
  return text === key ? fallback : text;
};

/** Runs `fn` once dictionaries are loaded and on every locale switch; returns an unsubscribe. */
function onLocale(fn) {
  const i18n = window.i18n;
  if (!i18n) return () => {};
  let live = true;
  const run = () => { if (live) fn(); };
  if (typeof i18n.onReady === 'function') i18n.onReady(run);
  const off = typeof i18n.onChange === 'function' ? i18n.onChange(run) : null;
  return () => { live = false; if (typeof off === 'function') off(); };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setLabel(node, label) {
  node.setAttribute('aria-label', label);
  node.title = label;
}

function actionButton(action, className, text, label) {
  const node = element('button', className, text);
  node.type = 'button';
  node.dataset.action = action;
  if (label !== undefined) setLabel(node, label);
  return node;
}

function sanitize(items) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item?.refdes !== 'string' || !item.refdes || seen.has(item.refdes)) continue;
    seen.add(item.refdes);
    result.push({ refdes: item.refdes, note: typeof item.note === 'string' ? item.note : '',
      done: Boolean(item.done), pinned: Boolean(item.pinned) });
  }
  return result;
}

export class Worklist {
  constructor(container, { request, onJump, notify } = {}) {
    this.container = container;
    this.request = request;
    this.onJump = onJump;
    this.notify = notify;
    this.boardId = null;
    this.items = [];
    this.ready = false;
    this.loadFailed = false;
    this.current = null;
    this._openNotes = new Set();
    this._generation = 0;
    this._timer = null;
    this._dirty = false;
    this._saves = Promise.resolve();
    this._events = new AbortController();
    this._statusText = null;
    this._build();
    this._offLocale = onLocale(() => {
      this._applyStaticText();
      this._setStatus(this._statusText);
      this._render();
    });
    window.addEventListener('pagehide', () => this.flush({ keepalive: true }), { signal: this._events.signal });
    this._render();
  }

  /** Saves pending edits of the previous board, then shows `boardId`'s list. */
  async load(boardId) {
    const saved = this.flush();
    const generation = this._switchTo(boardId ?? null);
    this._render();
    if (!boardId) return;
    this._setStatus(['pcb.worklist.status.loading', 'Loading…']);
    try {
      // Reopening a board must not read back a list older than its last edit.
      await saved;
      if (generation !== this._generation) return;
      const data = await this.request(this._path(boardId));
      if (generation !== this._generation) return;
      this.items = sanitize(data?.items);
      this.ready = true;
      this._setStatus(null);
      this._render();
    } catch (error) {
      if (generation !== this._generation) return;
      this.loadFailed = true;
      this._setStatus(['pcb.worklist.status.load_failed', 'Loading failed']);
      this._render();
      this.notify?.(tr('pcb.worklist.load_error', `The worklist could not be loaded: ${error.message}`,
        { message: error.message }), true);
    }
  }

  /** Adds a part, or moves to it when it is listed already. False if not added. */
  add(refdes) {
    const name = String(refdes ?? '').trim();
    if (!name) return false;
    if (!this.ready) {
      this.notify?.(tr('pcb.worklist.not_ready', 'The worklist has not loaded yet.'), true);
      return false;
    }
    if (this._item(name)) {
      this.current = name;
      this._render();
      this._scrollToCurrent();
      this.notify?.(tr('pcb.worklist.already_listed', `${name} is already on the worklist.`, { refdes: name }));
      return false;
    }
    if (this.items.length >= MAX_ITEMS) {
      this.notify?.(tr('pcb.worklist.limit', `The worklist is limited to ${MAX_ITEMS} entries.`, { n: MAX_ITEMS }), true);
      return false;
    }
    this.items.push({ refdes: name, note: '', done: false, pinned: false });
    this.current = name;
    this._changed();
    this._scrollToCurrent();
    return true;
  }

  /**
   * Detaches the panel from its board and empties the view. Stored items stay
   * on the server; `discard` drops unsaved edits, e.g. after deleting the board.
   * Use removeAll() to empty the stored list.
   */
  clear({ discard = false } = {}) {
    if (discard) this._dropPendingSave();
    else this.flush();
    this._switchTo(null);
    this._render();
  }

  removeAll() {
    if (!this.ready || !this.items.length) return;
    this.items = [];
    this.current = null;
    this._openNotes.clear();
    this._changed();
  }

  next() { this._step(1); }

  previous() { this._step(-1); }

  /** Writes pending edits now. The returned promise settles after the write. */
  flush(options) {
    clearTimeout(this._timer);
    this._timer = null;
    if (!this._dirty || !this.boardId) return this._saves;
    this._dirty = false;
    const boardId = this.boardId;
    const generation = this._generation;
    const body = JSON.stringify({ items: this.items });
    this._setStatus(['pcb.worklist.status.saving', 'Saving…']);
    this._saves = this._saves
      .then(() => this.request(this._path(boardId), { method: 'PUT', headers: JSON_HEADERS, body, ...options }))
      .then(() => {
        if (generation === this._generation && !this._dirty && this._timer === null) this._setStatus(['pcb.worklist.status.saved', 'Saved']);
      }, error => {
        if (generation === this._generation) {
          this._dirty = true;
          this._setStatus(['pcb.worklist.status.not_saved', 'Not saved']);
        }
        this.notify?.(tr('pcb.worklist.save_error', `The worklist could not be saved: ${error.message}`,
          { message: error.message }), true);
      });
    return this._saves;
  }

  dispose() {
    this.flush({ keepalive: true });
    this._offLocale();
    this._events.abort();
    this._generation++;
    this.container.replaceChildren();
  }

  _path(boardId) { return `/boards/${encodeURIComponent(boardId)}/worklist`; }

  _item(refdes) { return this.items.find(item => item.refdes === refdes); }

  _dropPendingSave() {
    clearTimeout(this._timer);
    this._timer = null;
    this._dirty = false;
  }

  _switchTo(boardId) {
    this._dropPendingSave();
    this.boardId = boardId;
    this.items = [];
    this.ready = false;
    this.loadFailed = false;
    this.current = null;
    this._openNotes.clear();
    this._setStatus(null);
    return ++this._generation;
  }

  _changed({ render = true } = {}) {
    this._dirty = true;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this._setStatus(['pcb.worklist.status.unsaved', 'Unsaved']);
    if (render) this._render();
  }

  /** Pinned entries first, otherwise in the order they were added. */
  _ordered() {
    return [...this.items.filter(item => item.pinned), ...this.items.filter(item => !item.pinned)];
  }

  _step(direction) {
    const order = this._ordered();
    if (!order.length) return;
    const count = order.length;
    const position = order.findIndex(item => item.refdes === this.current);
    const start = position === -1 ? (direction > 0 ? -1 : 0) : position;
    for (let distance = 1; distance <= count; distance++) {
      const candidate = order[(((start + direction * distance) % count) + count) % count];
      if (!candidate.done) { this._jump(candidate.refdes); return; }
    }
    this.notify?.(tr('pcb.worklist.all_done', 'All entries are done.'));
  }

  _jump(refdes) {
    this.current = refdes;
    this._render();
    this._scrollToCurrent();
    this.onJump?.(refdes);
  }

  _scrollToCurrent() {
    this.list.querySelector('.wl-row.current')?.scrollIntoView({ block: 'nearest' });
  }

  /** `status` is a `[key, fallback]` pair, kept so a locale switch can re-translate it. */
  _setStatus(status) {
    this._statusText = status || null;
    this.status.textContent = status ? tr(status[0], status[1]) : '';
  }

  /** Labels created once in _build(); re-applied when the locale changes. */
  _applyStaticText() {
    this.eyebrow.textContent = tr('pcb.worklist.eyebrow', 'WORKLIST');
    this.input.placeholder = tr('pcb.worklist.add_placeholder', 'Add component, e.g. U7000');
    this.input.setAttribute('aria-label', tr('pcb.worklist.add_aria', 'Add component to the worklist'));
    this.addButton.textContent = tr('pcb.worklist.add', 'Add');
    this.previousButton.textContent = tr('pcb.worklist.previous', '← Previous');
    setLabel(this.previousButton, tr('pcb.worklist.previous_title', 'Go to the previous open entry'));
    this.nextButton.textContent = tr('pcb.worklist.next', 'Next →');
    setLabel(this.nextButton, tr('pcb.worklist.next_title', 'Go to the next open entry'));
    this.removeAllButton.textContent = tr('pcb.worklist.remove_all', 'Remove all');
    setLabel(this.removeAllButton, tr('pcb.worklist.remove_all_title', 'Remove all entries'));
  }

  _build() {
    const root = element('div', 'wl');
    const head = element('div', 'wl-head');
    this.progress = element('span', 'wl-progress');
    this.status = element('span', 'wl-status');
    this.status.setAttribute('role', 'status');
    this.eyebrow = element('span', 'eyebrow');
    head.append(this.eyebrow, this.progress, this.status);

    this.form = element('form', 'wl-add');
    this.input = element('input', 'wl-input');
    this.input.type = 'text';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.addButton = element('button', 'secondary');
    this.addButton.type = 'submit';
    this.form.append(this.input, this.addButton);
    this.form.addEventListener('submit', event => {
      event.preventDefault();
      if (this.add(this.input.value)) this.input.value = '';
    });

    const nav = element('div', 'wl-nav');
    this.previousButton = actionButton('previous', 'secondary');
    this.nextButton = actionButton('next', 'secondary');
    this.removeAllButton = actionButton('remove-all', 'text-button danger');
    this._applyStaticText();
    nav.append(this.previousButton, this.nextButton, this.removeAllButton);
    nav.addEventListener('click', event => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'previous') this.previous();
      if (action === 'next') this.next();
      if (action === 'remove-all' && window.confirm(tr('pcb.worklist.remove_all_confirm', 'Remove all entries from this worklist?'))) this.removeAll();
    });

    this.list = element('ul', 'wl-list');
    this.list.addEventListener('click', event => this._onListClick(event));
    this.list.addEventListener('change', event => this._onListChange(event));
    this.list.addEventListener('input', event => this._onListInput(event));
    root.append(head, this.form, nav, this.list);
    this.container.replaceChildren(root);
  }

  _rowItem(target) {
    return this._item(target.closest('.wl-row')?.dataset.refdes);
  }

  _onListClick(event) {
    const control = event.target.closest('button[data-action]');
    if (!control) return;
    const item = this._rowItem(control);
    if (!item) return;
    const action = control.dataset.action;
    if (action === 'jump') this._jump(item.refdes);
    if (action === 'pin') { item.pinned = !item.pinned; this._changed(); }
    if (action === 'note') {
      if (this._openNotes.delete(item.refdes)) this._render();
      else {
        this._openNotes.add(item.refdes);
        this._render();
        this._rowFor(item.refdes)?.querySelector('textarea')?.focus();
      }
    }
    if (action === 'remove') {
      this.items.splice(this.items.indexOf(item), 1);
      this._openNotes.delete(item.refdes);
      if (this.current === item.refdes) this.current = null;
      this._changed();
    }
  }

  _onListChange(event) {
    if (event.target.dataset.action !== 'done') return;
    const item = this._rowItem(event.target);
    if (item) { item.done = event.target.checked; this._changed(); }
  }

  /** Notes update in place so typing never rebuilds the textarea. */
  _onListInput(event) {
    if (event.target.dataset.action !== 'note-text') return;
    const item = this._rowItem(event.target);
    if (!item) return;
    item.note = event.target.value;
    const row = event.target.closest('.wl-row');
    row.querySelector('[data-action="note"]').classList.toggle('active', Boolean(item.note));
    this._changed({ render: false });
  }

  _rowFor(refdes) {
    return [...this.list.children].find(row => row.dataset.refdes === refdes);
  }

  _renderRow(item) {
    const row = element('li', `wl-row${item.done ? ' done' : ''}${item.refdes === this.current ? ' current' : ''}`);
    row.dataset.refdes = item.refdes;
    const main = element('div', 'wl-main');
    const done = element('input', 'wl-done');
    done.type = 'checkbox';
    done.checked = item.done;
    done.dataset.action = 'done';
    done.setAttribute('aria-label', tr('pcb.worklist.mark_done', `Mark ${item.refdes} as done`, { refdes: item.refdes }));
    const name = actionButton('jump', 'wl-ref', item.refdes,
      tr('pcb.worklist.jump', `Jump to ${item.refdes}`, { refdes: item.refdes }));
    const preview = element('span', 'wl-preview', item.note.split('\n')[0]);
    const open = this._openNotes.has(item.refdes);
    const pin = actionButton('pin', `wl-icon${item.pinned ? ' active' : ''}`, item.pinned ? '★' : '☆',
      item.pinned ? tr('pcb.worklist.unpin', `Unpin ${item.refdes}`, { refdes: item.refdes })
        : tr('pcb.worklist.pin', `Pin ${item.refdes} to the top`, { refdes: item.refdes }));
    pin.setAttribute('aria-pressed', String(item.pinned));
    const noteLabel = tr('pcb.worklist.note', `Note on ${item.refdes}`, { refdes: item.refdes });
    const note = actionButton('note', `wl-icon${item.note ? ' active' : ''}`, '✎', noteLabel);
    note.setAttribute('aria-expanded', String(open));
    const remove = actionButton('remove', 'wl-icon', '×',
      tr('pcb.worklist.remove', `Remove ${item.refdes}`, { refdes: item.refdes }));
    main.append(done, name, preview, pin, note, remove);
    row.append(main);
    if (open) {
      const text = element('textarea', 'wl-note');
      text.value = item.note;
      text.maxLength = NOTE_MAX_LENGTH;
      text.rows = 3;
      text.placeholder = tr('pcb.worklist.note_placeholder', 'Readings, findings, next steps…');
      text.dataset.action = 'note-text';
      text.setAttribute('aria-label', noteLabel);
      row.append(text);
    }
    return row;
  }

  _render() {
    const active = document.activeElement;
    const focus = this.list.contains(active)
      ? { refdes: active.closest('.wl-row')?.dataset.refdes, action: active.dataset.action } : null;
    const finished = this.items.filter(item => item.done).length;
    this.progress.textContent = this.items.length ? `${finished}/${this.items.length}` : '';
    this.input.disabled = !this.ready;
    this.addButton.disabled = !this.ready;
    const hasOpen = this.items.some(item => !item.done);
    this.previousButton.disabled = !hasOpen;
    this.nextButton.disabled = !hasOpen;
    this.removeAllButton.disabled = !this.items.length;
    if (!this.items.length) {
      this.list.replaceChildren(element('li', 'wl-empty', !this.boardId ? tr('pcb.worklist.empty_no_board', 'No board open.')
        : this.loadFailed ? tr('pcb.worklist.empty_unavailable', 'Worklist unavailable.')
        : this.ready ? tr('pcb.worklist.empty', 'No entries yet. Add the first component.')
        : tr('pcb.worklist.status.loading', 'Loading…')));
      return;
    }
    this.list.replaceChildren(...this._ordered().map(item => this._renderRow(item)));
    if (focus?.refdes && focus.action) {
      this._rowFor(focus.refdes)?.querySelector(`[data-action="${focus.action}"]`)?.focus();
    }
  }
}
