// Side-by-side pin table for one part across two open boards. Boards are always
// looked up through getOpenBoards(), so an evicted board is not kept alive here.
import { closeIcon } from './pcb_board_tabs.js';
import { comparePinout, DIFFERING_STATUSES, differingPinRefs, STATUSES } from './pcb_part_compare.js';

const ROW_BATCH = 400;
const STATUS_LABEL = {
  same: 'Same', renamed: 'Renamed', equivalent_rail: 'Same rail',
  unused: 'Unused', different: 'Different', missing: 'Missing',
};
let instances = 0;

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

const statusLabel = status => tr(`pcb.compare.status.${status}`, STATUS_LABEL[status] ?? status);

// Number formats follow the UI locale; without i18n the browser locale applies.
const formatters = new Map();
function formatNumber(value, minimumFractionDigits, maximumFractionDigits) {
  const tag = window.i18n?.intlTag;
  const id = `${tag}|${minimumFractionDigits}|${maximumFractionDigits}`;
  if (!formatters.has(id)) {
    formatters.set(id, new Intl.NumberFormat(tag || undefined, { minimumFractionDigits, maximumFractionDigits }));
  }
  return formatters.get(id).format(value);
}
const decimal = { format: value => formatNumber(value, 0, 3) };
const twoDecimals = { format: value => formatNumber(value, 2, 2) };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function reading(side) {
  if (!side) return '';
  const parts = [];
  if (side.expected_voltage_v != null) parts.push(`${decimal.format(side.expected_voltage_v)} V`);
  if (side.expected_open) parts.push('OL');
  else if (side.expected_resistance_ohms != null) parts.push(`${decimal.format(side.expected_resistance_ohms)} Ω`);
  return parts.join(' · ');
}

const netText = side => (side ? side.net || tr('pcb.compare.not_connected', 'not connected') : tr('pcb.compare.no_pin', 'no pin'));

function connectivityText(evidence) {
  if (!evidence || evidence.jaccard === null) return tr('pcb.compare.connectivity_none', 'no other connections to compare');
  const total = evidence.shared + evidence.onlyA + evidence.onlyB;
  const jaccard = twoDecimals.format(evidence.jaccard);
  return tr('pcb.compare.connectivity', `${evidence.shared} of ${total} connections shared, Jaccard ${jaccard}`,
    { shared: evidence.shared, total, jaccard });
}

function explain(row, threshold) {
  const evidence = connectivityText(row.evidence);
  const limit = twoDecimals.format(threshold);
  const why = (fallback, params) => tr(`pcb.compare.why.${row.reason}`, fallback, params);
  switch (row.reason) {
    case 'names_equal': return why('Same net name on both boards.');
    case 'auto_name_connectivity_match':
      return why(`Same export number, connections match (${evidence}).`, { evidence });
    case 'auto_name_collision':
      return why(`Same export number but different connections (${evidence}). The number says nothing about the net.`, { evidence });
    case 'connectivity_match':
      return why(`Different name, same connections (${evidence}, threshold ${limit}).`, { evidence, threshold: limit });
    case 'names_and_connectivity_differ':
      return why(`Differs: ${evidence} (threshold ${limit}).`, { evidence, threshold: limit });
    case 'rail_name_match': return why('Same rail by naming convention.');
    case 'ground_alias': return why('Both nets are ground.');
    case 'no_connection_marker': {
      const letter = row.unusedSide?.toUpperCase();
      const side = row.unusedSide === 'both' ? tr('pcb.compare.side_both', 'both sides')
        : tr('pcb.compare.side_one', `side ${letter}`, { side: letter });
      const connected = [row.a, row.b].filter(entry => entry?.net && entry.connections > 0)
        .map(entry => tr('pcb.compare.more_connections', `${entry.net}: ${entry.connections} more connections`,
          { net: entry.net, n: entry.connections }));
      const text = why(`Marked as not connected on ${side}, not a fault.`, { side });
      return `${text}${connected.length ? ` (${connected.join(', ')})` : ''}`;
    }
    case 'pin_absent_on_b': return why('This pin exists only on side A.');
    case 'pin_absent_on_a': return why('This pin exists only on side B.');
    default: return '';
  }
}

export class PartCompareView {
  /**
   * @param {HTMLElement} container Element the view renders into; hidden until show().
   * @param {object} options
   * @param {() => Array<{id, title, board}>} options.getOpenBoards `tabs.all` fits directly.
   * @param {(pinIndexes: number[]|null) => void} options.onHighlightPins Positions in the shown board's `pins`.
   * @param {(boardId, pin) => void} options.onFocusPin `pin` has part_refdes, name, index, net, pos, layer.
   * @param {(id) => Promise} [options.ensureBoard] Reloads evicted boards, e.g. `id => tabs.ensureBoard(id)`.
   */
  constructor(container, { getOpenBoards, onHighlightPins, onFocusPin, ensureBoard } = {}) {
    this.container = container;
    this.getOpenBoards = getOpenBoards;
    this.onHighlightPins = onHighlightPins;
    this.onFocusPin = onFocusPin;
    this.ensureBoard = ensureBoard;
    this.boardId = null;
    this.refdes = null;
    this.otherId = null;
    this.result = null;
    this.highlighting = false;
    this.limit = ROW_BATCH;
    this.visibleRows = [];
    this._request = 0;
    this._listId = `pcv-parts-${++instances}`;
    this._notice = null;
    this._build();
    container.hidden = true;
    onLocale(() => this._retranslate());
  }

  /** Open the comparison for a part of the board shown in the viewer. */
  show(boardId, refdes) {
    this.boardId = boardId;
    this.refdes = refdes;
    this.container.hidden = false;
    this.title.textContent = refdes;
    const boards = this.getOpenBoards();
    this._fillBoardPicker(boards);
    const keep = this.otherId !== boardId && boards.some(entry => entry.id === this.otherId);
    if (!keep) this.otherId = boards.find(entry => entry.id !== boardId)?.id ?? boardId;
    this.boardPicker.value = String(this.otherId);
    this.partInput.value = '';
    return this._selectBoard(this.otherId, refdes);
  }

  /** Re-sends the board highlight, e.g. after its board returned to the viewer. */
  reapplyHighlight() { this._emitHighlight(); }

  hide() {
    this._request += 1;
    this.container.hidden = true;
    this.result = null;
    this.visibleRows = [];
    this.tbody.replaceChildren();
    this.partList.replaceChildren();
    if (this.highlighting) {
      this.highlighting = false;
      this.highlightToggle.checked = false;
      this.onHighlightPins?.(null);
    }
  }

  _build() {
    const root = this.container;
    root.classList.add('pcv');
    root.replaceChildren();

    const head = el('header', 'pcv-head');
    this.eyebrow = el('span', 'pcv-eyebrow');
    head.append(this.eyebrow);
    this.title = el('strong', 'pcv-refdes');
    const close = el('button', 'pcv-close');
    close.type = 'button';
    close.append(closeIcon());
    this.closeButton = close;
    close.addEventListener('click', () => this.hide());
    head.append(this.title, close);

    const controls = el('div', 'pcv-controls');
    this.boardLabel = document.createTextNode('');
    const boardField = el('label', 'pcv-field');
    boardField.append(this.boardLabel);
    this.boardPicker = el('select');
    this.boardPicker.addEventListener('change', () => {
      this.otherId = this._pickedBoardId();
      this.partInput.value = '';
      this._selectBoard(this.otherId, this.refdes);
    });
    boardField.append(this.boardPicker);
    this.partLabel = document.createTextNode('');
    const partField = el('label', 'pcv-field');
    partField.append(this.partLabel);
    this.partInput = el('input', 'pcv-mono');
    this.partInput.setAttribute('list', this._listId);
    this.partInput.spellcheck = false;
    this.partInput.autocomplete = 'off';
    this.partList = el('datalist');
    this.partList.id = this._listId;
    this.partInput.addEventListener('change', () => this._compare(this.partInput.value.trim()));
    partField.append(this.partInput, this.partList);
    const filterField = el('label', 'pcv-check');
    this.differingOnly = el('input');
    this.differingOnly.type = 'checkbox';
    this.differingOnly.addEventListener('change', () => { this.limit = ROW_BATCH; this._renderRows(); });
    this.filterLabel = document.createTextNode('');
    filterField.append(this.differingOnly, this.filterLabel);
    const markField = el('label', 'pcv-check');
    this.highlightToggle = el('input');
    this.highlightToggle.type = 'checkbox';
    this.highlightToggle.addEventListener('change', () => {
      this.highlighting = this.highlightToggle.checked;
      this._emitHighlight();
    });
    this.markLabel = document.createTextNode('');
    markField.append(this.highlightToggle, this.markLabel);
    controls.append(boardField, partField, filterField, markField);

    this.summary = el('div', 'pcv-summary');
    this.notice = el('p', 'pcv-notice');
    this.notice.hidden = true;
    this.notice.setAttribute('role', 'status');

    const scroller = el('div', 'pcv-scroll');
    const table = el('table', 'pcv-table');
    const thead = el('thead');
    const sides = el('tr', 'pcv-sides');
    this.headA = el('th', 'pcv-side');
    this.headA.colSpan = 2;
    this.headB = el('th', 'pcv-side');
    this.headB.colSpan = 2;
    sides.append(el('th'), this.headA, el('th'), this.headB);
    const columns = el('tr');
    this.columnHeads = Array.from({ length: 6 }, () => el('th'));
    columns.append(...this.columnHeads);
    thead.append(sides, columns);
    this.tbody = el('tbody');
    table.append(thead, this.tbody);
    scroller.append(table);
    this.tbody.addEventListener('mouseover', event => this._hover(event.target));
    this.tbody.addEventListener('focusin', event => this._hover(event.target));
    this.tbody.addEventListener('mouseleave', () => this._clearDetail());
    this.tbody.addEventListener('click', event => this._onTableClick(event));

    this.detail = el('footer', 'pcv-detail');
    root.append(head, controls, this.summary, this.notice, scroller, this.detail);
    this._applyStaticText();
    this._clearDetail();
  }

  /** Labels created once in _build(); re-applied when the locale changes. */
  _applyStaticText() {
    this.eyebrow.textContent = tr('pcb.compare.eyebrow', 'PIN COMPARISON');
    this.closeButton.setAttribute('aria-label', tr('pcb.compare.close', 'Close comparison'));
    this.boardLabel.data = tr('pcb.compare.compare_with', 'Compare with');
    this.partLabel.data = tr('pcb.compare.part', 'Component');
    this.filterLabel.data = ` ${tr('pcb.compare.differing_only', 'Differences only')}`;
    this.markLabel.data = ` ${tr('pcb.compare.mark_on_board', 'Mark on the board')}`;
    const net = tr('pcb.compare.col_net', 'Net');
    const expected = tr('pcb.compare.col_expected', 'Expected');
    const labels = [tr('pcb.compare.col_pin', 'Pin'), net, expected, tr('pcb.compare.col_status', 'Status'), net, expected];
    this.columnHeads.forEach((head, index) => { head.textContent = labels[index]; });
  }

  /** Re-renders every translated string after dictionaries load or the locale changes. */
  _retranslate() {
    this._applyStaticText();
    if (this.container.hidden) return;
    const picked = this.boardPicker.value;
    this._fillBoardPicker(this.getOpenBoards());
    this.boardPicker.value = picked;
    if (this.result) {
      this._showWarnings();
      this.headA.textContent = this._sideTitle(this.boardId, this.result.parts.a);
      this.headB.textContent = this._sideTitle(this.otherId, this.result.parts.b);
      this._renderSummary();
      this._renderRows();
    } else {
      this.notice.textContent = this._notice ? this._notice() : '';
    }
    this._clearDetail();
  }

  _showWarnings() {
    const { warnings } = this.result.summary;
    this.notice.hidden = !warnings.length;
    if (warnings.includes('no_common_pin_labels')) {
      this.notice.textContent = tr('pcb.compare.no_common_labels',
        'The pin labels of the two components do not match, so no pin could be paired.');
    }
  }

  _pickedBoardId() {
    const entry = this.getOpenBoards().find(item => String(item.id) === this.boardPicker.value);
    return entry ? entry.id : this.boardPicker.value;
  }

  _fillBoardPicker(boards) {
    this.boardPicker.replaceChildren(...boards.map(entry => {
      const text = entry.id === this.boardId
        ? tr('pcb.compare.this_board', `${entry.title} (this board)`, { title: entry.title }) : entry.title;
      return new Option(text, String(entry.id));
    }));
  }

  _entry(id) { return this.getOpenBoards().find(entry => entry.id === id) ?? null; }

  async _boardFor(id) {
    const entry = this._entry(id);
    if (entry?.board) return entry.board;
    return entry && this.ensureBoard ? (await this.ensureBoard(id)) ?? null : null;
  }

  // Runs when the second board changes: refreshes the part list and picks a part.
  async _selectBoard(otherId, preferredRefdes) {
    const request = ++this._request;
    this._reset(() => tr('pcb.compare.loading_board', 'Loading board…'));
    const other = await this._boardFor(otherId);
    if (request !== this._request) return;
    if (!other) {
      this._reset(() => tr('pcb.compare.board_not_loaded', 'This board is not loaded. Open its tab and try again.'));
      return;
    }
    this.partList.replaceChildren(...other.parts.map(part => new Option(part.value || '', part.refdes)));
    const known = other.parts.some(part => part.refdes === preferredRefdes);
    if (otherId === this.boardId) {
      this._reset(() => tr('pcb.compare.need_second_board', 'Open a second board or pick another component of this board.'));
    } else if (known) {
      this.partInput.value = preferredRefdes;
      await this._compare(preferredRefdes, request);
    } else {
      this._reset(() => tr('pcb.compare.part_missing_pick',
        `“${preferredRefdes}” does not exist on this board. Pick a component.`, { refdes: preferredRefdes }));
    }
  }

  async _compare(refdesB, request = ++this._request) {
    if (!refdesB) return;
    const [boardA, boardB] = await Promise.all([this._boardFor(this.boardId), this._boardFor(this.otherId)]);
    if (request !== this._request) return;
    if (!boardA || !boardB) {
      this._reset(() => tr('pcb.compare.boards_not_loaded', 'One of the boards is not loaded.'));
      return;
    }
    const result = comparePinout(boardA, this.refdes, boardB, refdesB);
    if (!result.found) {
      const side = result.missing.includes('a') ? this.refdes : refdesB;
      this._reset(() => tr('pcb.compare.part_missing', `“${side}” does not exist on this board.`, { refdes: side }));
      return;
    }
    this.result = result;
    this.limit = ROW_BATCH;
    this._notice = null;
    this._showWarnings();
    this.headA.textContent = this._sideTitle(this.boardId, result.parts.a);
    this.headB.textContent = this._sideTitle(this.otherId, result.parts.b);
    this._renderSummary();
    this._renderRows();
    this._clearDetail();
    if (this.highlighting) this._emitHighlight();
  }

  _sideTitle(id, part) {
    const details = [part.value, part.footprint].filter(Boolean).join(' · ');
    return `${this._entry(id)?.title ?? id} — ${part.refdes}${details ? ` (${details})` : ''}${part.is_dnp ? ' · DNP' : ''}`;
  }

  // Clears the current result; a stale highlight must not outlive it.
  // `message` is a function so the notice can be re-translated on a locale switch.
  _reset(message) {
    this._notice = message;
    const text = message();
    this.result = null;
    this.visibleRows = [];
    this.tbody.replaceChildren();
    this.summary.replaceChildren();
    this.headA.textContent = '';
    this.headB.textContent = '';
    this.notice.textContent = text;
    this.notice.hidden = !text;
    this._clearDetail();
    if (this.highlighting) this._emitHighlight();
  }

  _emitHighlight() {
    this.onHighlightPins?.(this.highlighting && this.result ? differingPinRefs(this.result, 'a') : null);
  }

  _renderSummary() {
    const { summary } = this.result;
    this.summary.replaceChildren(...STATUSES.filter(status => summary[status] > 0).map(status => {
      const chip = el('span', `pcv-chip st-${status}`);
      chip.append(el('b', '', String(summary[status])), ` ${statusLabel(status)}`);
      return chip;
    }));
  }

  _renderRows() {
    if (!this.result) return;
    const rows = this.differingOnly.checked
      ? this.result.rows.filter(row => DIFFERING_STATUSES.includes(row.status)) : this.result.rows;
    this.visibleRows = rows;
    this.tbody.replaceChildren(...rows.slice(0, this.limit).map((row, position) => this._rowElement(row, position)));
    if (!rows.length) {
      const empty = el('tr', 'pcv-empty');
      const cell = el('td', '', this.differingOnly.checked
        ? tr('pcb.compare.no_differing_pins', 'No differing pins.') : tr('pcb.compare.no_pins', 'This component has no pins.'));
      cell.colSpan = 6;
      empty.append(cell);
      this.tbody.append(empty);
    } else if (rows.length > this.limit) {
      const more = el('tr', 'pcv-more');
      const cell = el('td');
      cell.colSpan = 6;
      const remaining = rows.length - this.limit;
      const button = el('button', '', tr('pcb.compare.show_more', `Show more pins (${remaining})`, { n: remaining }));
      button.type = 'button';
      button.dataset.more = '1';
      cell.append(button);
      more.append(cell);
      this.tbody.append(more);
    }
  }

  _rowElement(row, position) {
    const tr = el('tr', `st-${row.status}`);
    tr.dataset.row = String(position);
    const pin = el('td', 'pcv-pin', row.occurrence ? `${row.pin} (${row.occurrence})` : row.pin);
    const status = el('td', 'pcv-status');
    status.append(el('span', `pcv-chip st-${row.status}`, statusLabel(row.status)));
    tr.append(pin, this._netCell(row, 'a'), el('td', 'pcv-reading', reading(row.a)),
      status, this._netCell(row, 'b'), el('td', 'pcv-reading', reading(row.b)));
    return tr;
  }

  _netCell(row, side) {
    const cell = el('td', 'pcv-net');
    if (!row[side]) {
      cell.append(el('span', 'pcv-none', tr('pcb.compare.no_pin', 'no pin')));
      return cell;
    }
    const button = el('button', row[side].net ? '' : 'pcv-none', netText(row[side]));
    button.type = 'button';
    button.dataset.side = side;
    const pinName = `${row[side].part_refdes}.${row[side].label}`;
    button.title = tr('pcb.compare.show_pin_title', `Show ${pinName} on the board`, { pin: pinName });
    cell.append(button);
    return cell;
  }

  _rowOf(target) {
    const tr = target.closest?.('tr[data-row]');
    return tr ? this.visibleRows[Number(tr.dataset.row)] ?? null : null;
  }

  _hover(target) {
    const row = this._rowOf(target);
    if (!row) return;
    const threshold = this.result.summary.jaccardThreshold;
    this.detail.replaceChildren(
      el('b', 'pcv-mono', tr('pcb.compare.detail_pin', `Pin ${row.pin}`, { pin: row.pin })),
      el('span', 'pcv-mono', ` A: ${netText(row.a)}  ↔  B: ${netText(row.b)}`),
      el('span', 'pcv-why', explain(row, threshold)),
    );
  }

  _clearDetail() {
    this.detail.replaceChildren(el('span', 'pcv-hint', tr('pcb.compare.detail_hint', 'Hover a row for details, click a net to show the pin.')));
  }

  _onTableClick(event) {
    const button = event.target.closest?.('button');
    if (!button) return;
    if (button.dataset.more) {
      this.limit += ROW_BATCH;
      this._renderRows();
      return;
    }
    const row = this._rowOf(button);
    const side = button.dataset.side;
    if (row && side && row[side]) this.onFocusPin?.(side === 'a' ? this.boardId : this.otherId, row[side]);
  }
}
