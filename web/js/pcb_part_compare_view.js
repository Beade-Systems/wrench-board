// Side-by-side pin table for one part across two open boards. Boards are always
// looked up through getOpenBoards(), so an evicted board is not kept alive here.
import { closeIcon } from './pcb_board_tabs.js';
import { comparePinout, DIFFERING_STATUSES, differingPinRefs, STATUSES } from './pcb_part_compare.js';

const ROW_BATCH = 400;
const STATUS_LABEL = {
  same: 'Gleich', renamed: 'Umbenannt', equivalent_rail: 'Gleiche Schiene',
  unused: 'Unbenutzt', different: 'Abweichend', missing: 'Fehlt',
};
const decimal = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 3 });
const twoDecimals = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let instances = 0;

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

const netText = side => (side ? side.net || 'nicht verbunden' : 'kein Pin');

function connectivityText(evidence) {
  if (!evidence || evidence.jaccard === null) return 'keine weiteren Anschlüsse zum Vergleichen';
  const total = evidence.shared + evidence.onlyA + evidence.onlyB;
  return `${evidence.shared} von ${total} Anschlüssen gemeinsam, Jaccard ${twoDecimals.format(evidence.jaccard)}`;
}

function explain(row, threshold) {
  const unusedSide = row.unusedSide === 'both' ? 'beiden Seiten' : `Seite ${row.unusedSide?.toUpperCase()}`;
  switch (row.reason) {
    case 'names_equal': return 'Gleicher Netzname auf beiden Platinen.';
    case 'auto_name_connectivity_match': return `Gleiche Exportnummer, Anschlüsse stimmen überein (${connectivityText(row.evidence)}).`;
    case 'auto_name_collision': return `Gleiche Exportnummer, aber andere Anschlüsse (${connectivityText(row.evidence)}). Die Nummer sagt nichts über das Netz aus.`;
    case 'connectivity_match': return `Anderer Name, gleiche Anschlüsse (${connectivityText(row.evidence)}, Schwelle ${twoDecimals.format(threshold)}).`;
    case 'names_and_connectivity_differ': return `Weicht ab: ${connectivityText(row.evidence)} (Schwelle ${twoDecimals.format(threshold)}).`;
    case 'rail_name_match': return 'Gleiche Versorgungsschiene nach Namenskonvention.';
    case 'ground_alias': return 'Beide Netze sind Masse.';
    case 'no_connection_marker': {
      const connected = [row.a, row.b].filter(side => side?.net && side.connections > 0)
        .map(side => `${side.net}: ${side.connections} weitere Anschlüsse`);
      return `Auf ${unusedSide} als nicht verbunden markiert, kein Fehler.${connected.length ? ` (${connected.join(', ')})` : ''}`;
    }
    case 'pin_absent_on_b': return 'Diesen Pin gibt es nur auf Seite A.';
    case 'pin_absent_on_a': return 'Diesen Pin gibt es nur auf Seite B.';
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
    this._build();
    container.hidden = true;
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
    head.append(el('span', 'pcv-eyebrow', 'PINVERGLEICH'));
    this.title = el('strong', 'pcv-refdes');
    const close = el('button', 'pcv-close');
    close.type = 'button';
    close.append(closeIcon());
    close.setAttribute('aria-label', 'Vergleich schließen');
    close.addEventListener('click', () => this.hide());
    head.append(this.title, close);

    const controls = el('div', 'pcv-controls');
    const boardField = el('label', 'pcv-field', 'Vergleichen mit');
    this.boardPicker = el('select');
    this.boardPicker.addEventListener('change', () => {
      this.otherId = this._pickedBoardId();
      this.partInput.value = '';
      this._selectBoard(this.otherId, this.refdes);
    });
    boardField.append(this.boardPicker);
    const partField = el('label', 'pcv-field', 'Bauteil');
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
    filterField.append(this.differingOnly, ' Nur Abweichungen');
    const markField = el('label', 'pcv-check');
    this.highlightToggle = el('input');
    this.highlightToggle.type = 'checkbox';
    this.highlightToggle.addEventListener('change', () => {
      this.highlighting = this.highlightToggle.checked;
      this._emitHighlight();
    });
    markField.append(this.highlightToggle, ' Auf dem Board markieren');
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
    for (const label of ['Pin', 'Netz', 'Soll', 'Status', 'Netz', 'Soll']) columns.append(el('th', '', label));
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
    this._clearDetail();
  }

  _pickedBoardId() {
    const entry = this.getOpenBoards().find(item => String(item.id) === this.boardPicker.value);
    return entry ? entry.id : this.boardPicker.value;
  }

  _fillBoardPicker(boards) {
    this.boardPicker.replaceChildren(...boards.map(entry => {
      const suffix = entry.id === this.boardId ? ' (diese Platine)' : '';
      return new Option(`${entry.title}${suffix}`, String(entry.id));
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
    this._reset('Platine wird geladen …');
    const other = await this._boardFor(otherId);
    if (request !== this._request) return;
    if (!other) {
      this._reset('Diese Platine ist nicht geladen. Öffne ihren Tab und versuche es erneut.');
      return;
    }
    this.partList.replaceChildren(...other.parts.map(part => new Option(part.value || '', part.refdes)));
    const known = other.parts.some(part => part.refdes === preferredRefdes);
    if (otherId === this.boardId) {
      this._reset('Öffne eine zweite Platine oder wähle ein anderes Bauteil dieser Platine.');
    } else if (known) {
      this.partInput.value = preferredRefdes;
      await this._compare(preferredRefdes, request);
    } else {
      this._reset(`„${preferredRefdes}“ gibt es auf dieser Platine nicht. Bitte ein Bauteil auswählen.`);
    }
  }

  async _compare(refdesB, request = ++this._request) {
    if (!refdesB) return;
    const [boardA, boardB] = await Promise.all([this._boardFor(this.boardId), this._boardFor(this.otherId)]);
    if (request !== this._request) return;
    if (!boardA || !boardB) {
      this._reset('Eine der Platinen ist nicht geladen.');
      return;
    }
    const result = comparePinout(boardA, this.refdes, boardB, refdesB);
    if (!result.found) {
      const side = result.missing.includes('a') ? this.refdes : refdesB;
      this._reset(`„${side}“ gibt es auf dieser Platine nicht.`);
      return;
    }
    this.result = result;
    this.limit = ROW_BATCH;
    this.notice.hidden = !result.summary.warnings.length;
    if (result.summary.warnings.includes('no_common_pin_labels')) {
      this.notice.textContent = 'Die Pin-Bezeichnungen beider Bauteile passen nicht zueinander, deshalb konnte kein Pin zugeordnet werden.';
    }
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
  _reset(message) {
    this.result = null;
    this.visibleRows = [];
    this.tbody.replaceChildren();
    this.summary.replaceChildren();
    this.headA.textContent = '';
    this.headB.textContent = '';
    this.notice.textContent = message;
    this.notice.hidden = !message;
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
      chip.append(el('b', '', String(summary[status])), ` ${STATUS_LABEL[status]}`);
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
      const cell = el('td', '', this.differingOnly.checked ? 'Keine abweichenden Pins.' : 'Dieses Bauteil hat keine Pins.');
      cell.colSpan = 6;
      empty.append(cell);
      this.tbody.append(empty);
    } else if (rows.length > this.limit) {
      const more = el('tr', 'pcv-more');
      const cell = el('td');
      cell.colSpan = 6;
      const button = el('button', '', `Weitere Pins anzeigen (${rows.length - this.limit})`);
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
    status.append(el('span', `pcv-chip st-${row.status}`, STATUS_LABEL[row.status]));
    tr.append(pin, this._netCell(row, 'a'), el('td', 'pcv-reading', reading(row.a)),
      status, this._netCell(row, 'b'), el('td', 'pcv-reading', reading(row.b)));
    return tr;
  }

  _netCell(row, side) {
    const cell = el('td', 'pcv-net');
    if (!row[side]) {
      cell.append(el('span', 'pcv-none', 'kein Pin'));
      return cell;
    }
    const button = el('button', row[side].net ? '' : 'pcv-none', netText(row[side]));
    button.type = 'button';
    button.dataset.side = side;
    button.title = `${row[side].part_refdes}.${row[side].label} auf dem Board anzeigen`;
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
      el('b', 'pcv-mono', `Pin ${row.pin}`),
      el('span', 'pcv-mono', ` A: ${netText(row.a)}  ↔  B: ${netText(row.b)}`),
      el('span', 'pcv-why', explain(row, threshold)),
    );
  }

  _clearDetail() {
    this.detail.replaceChildren(el('span', 'pcv-hint', 'Zeile überfahren für Details, Netz anklicken, um den Pin anzuzeigen.'));
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
