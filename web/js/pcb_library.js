import { saveOffline } from './offline_store.js';
import { LibraryViewer } from './pcb_library_viewer.js';
import { CatalogBrowser } from './pcb_catalog.js';
import { BoardTabs } from './pcb_board_tabs.js';
import { PartCompareView } from './pcb_part_compare_view.js';
import { SchematicDock } from './pcb_library_schematic.js';
import { Worklist } from './pcb_worklist.js';
import { ColorRulesEditor, loadRules } from './pcb_color_rules.js';
import { adjacentNets } from './pcb_net_walk.js';
import { matchesNet, matchesPart, parseQuery } from './pcb_entity_query.js';

const $ = id => document.getElementById(id);
const number = value => new Intl.NumberFormat('de-DE').format(value);
const state = { boards: [], active: null, board: null, favorites: false, tab: 'parts', panel: 'parts', limit: 250, busy: false };
let notificationTimer;
let opening;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function notify(message, error = false, persistent = false) {
  clearTimeout(notificationTimer);
  $('notification').textContent = message;
  $('notification').classList.toggle('error', error);
  $('notification').hidden = false;
  if (!persistent) notificationTimer = setTimeout(() => { $('notification').hidden = true; }, error ? 12000 : 6000);
}

async function request(path, options = {}) {
  const response = await fetch(`/api/library${path}`, { cache: 'no-store', ...options });
  if (!response.ok) {
    let message = `Anfrage fehlgeschlagen (HTTP ${response.status}).`;
    try {
      const error = await response.json();
      const detail = error.detail;
      if (typeof detail === 'string') message = detail;
      else if (detail?.detail === 'file-too-large') message = `Die Datei ist zu groß. Maximal ${Math.round(detail.max_bytes / 1048576)} MB sind erlaubt.`;
      else if (detail?.detail === 'empty-file') message = 'Die Datei ist leer.';
      else if (detail?.detail === 'fz-key-missing') message = 'Der FZ-Schlüssel fehlt. Öffne Einstellungen → Boardview-Schlüssel, lade den Schlüssel und speichere die Einstellungen.';
      else if (detail?.detail === 'unsupported-format') message = 'Dieses Dateiformat wird nicht unterstützt.';
      else if (detail?.message?.includes('pcbnew not available')) message = 'Für native KiCad-Dateien muss KiCad mit dem Python-Modul pcbnew auf dem Server installiert sein. Alternativ einen Boardview-Export importieren.';
      else if (detail?.message) message = detail.message;
    } catch { /* Keep HTTP status when the response is not JSON. */ }
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
}

const viewer = new LibraryViewer($('board-canvas'), renderSelection, position => {
  $('dimensions').textContent = `X ${(position.x * .0254).toFixed(2)} · Y ${(position.y * .0254).toFixed(2)} mm`;
});
const catalog = new CatalogBrowser({ request, notify, getBoards: () => state.boards,
  openBoard: async id => { await refresh();await openBoard(id); } });
const tabs = new BoardTabs($('board-tabs'), {
  onActivate: showBoard,
  onClose: tabClosed,
  loadBoard: id => request(`/boards/${encodeURIComponent(id)}`),
  getView: () => viewer.getView(),
  onError: (tab, error) => notify(`${tab.title} konnte nicht geladen werden: ${error.message}`, true),
});
const worklist = new Worklist($('worklist-panel'), { request, notify, onJump: refdes => {
  const part = state.board?.parts.find(candidate => candidate.refdes === refdes);
  if (part) focusPart(part); else notify(`${refdes} gibt es auf dieser Platine nicht.`, true);
} });
const compare = new PartCompareView($('part-compare'), {
  getOpenBoards: () => tabs.all,
  ensureBoard: id => tabs.ensureBoard(id),
  onHighlightPins: pins => viewer.setHighlightedPins(pins ? new Set(pins) : null),
  onFocusPin: async (boardId, pin) => {
    if (boardId === state.active?.id || await tabs.activate(boardId)) showPin(pin);
  },
});
const schematic = new SchematicDock({ request, notify, onTerm: findOnBoard });
const colorRules = new ColorRulesEditor($('colors-panel'), {
  onPreview: rules => viewer.setColorRules(rules),
  onApply: rules => { viewer.setColorRules(rules);notify('Farbregeln gespeichert.'); },
});
viewer.setColorRules(loadRules());
tabs.bindKeys();

function showBrowser() {
  opening?.abort();
  $('catalog-browser').hidden = false;$('workspace').hidden = true;$('browse-catalog').hidden = true;
  catalog.updateImports();
  history.replaceState(null, '', catalog.hash());
}

$('browse-catalog').addEventListener('click', showBrowser);

function renderCatalog() {
  $('board-count').textContent = number(state.boards.length);
  const query = $('library-search').value.trim().toLocaleLowerCase();
  const boards = state.boards.filter(board => (!state.favorites || board.favorite)
    && `${board.title} ${board.filename} ${board.format} ${board.notes}`.toLocaleLowerCase().includes(query));
  boards.sort($('sort').value === 'name' ? (a, b) => a.title.localeCompare(b.title, 'de', { numeric: true })
    : $('sort').value === 'parts' ? (a, b) => b.parts_count - a.parts_count
    : (a, b) => b.imported_at.localeCompare(a.imported_at));
  $('board-list').replaceChildren();
  if (!boards.length) {
    $('board-list').append(element('p', 'placeholder', state.boards.length
      ? 'Keine Platinen für diese Suche.' : 'Deine Bibliothek ist noch leer. Importiere deine erste PCB-Datei.'));
  }
  for (const board of boards) {
    const button = element('button', `board-card${state.active?.id === board.id ? ' active' : ''}`);
    button.type = 'button';button.title = board.filename;
    button.setAttribute('aria-pressed', String(state.active?.id === board.id));
    const copy = element('div', 'board-copy');
    copy.append(element('strong', '', board.title), element('small', '', `${board.format.toUpperCase()} · ${number(board.parts_count)} Bauteile`));
    button.append(element('span', 'board-icon', '▦'), copy);
    if (board.favorite) button.append(element('span', 'star', '★'));
    button.addEventListener('click', () => openBoard(board.id));
    $('board-list').append(button);
  }
}

async function refresh() {
  const data = await request('/boards');
  state.boards = data.boards;
  renderCatalog();
  catalog.updateImports();
  for (const tab of tabs.all) if (!state.boards.some(board => board.id === tab.id)) dropBoard(tab.id);
}

function updateMetadata(metadata) {
  state.active = metadata;
  const tab = tabs.active;
  if (tab?.id === metadata.id) { tab.metadata = metadata;tab.title = metadata.title;tabs.activate(tab.id); }
  const index = state.boards.findIndex(board => board.id === metadata.id);
  if (index < 0) state.boards.unshift(metadata); else state.boards[index] = metadata;
  $('board-title').textContent = metadata.title;
  $('board-subtitle').textContent = `${metadata.filename} · ${size(metadata.size_bytes)} · Importiert am ${new Date(metadata.imported_at).toLocaleDateString('de-DE')}`;
  $('favorite').textContent = metadata.favorite ? '★' : '☆';
  $('favorite').setAttribute('aria-pressed', String(metadata.favorite));
  $('favorite').setAttribute('aria-label', metadata.favorite ? 'Aus Favoriten entfernen' : 'Als Favorit markieren');
  $('edit-title').value = metadata.title;
  $('edit-notes').value = metadata.notes;
  renderCatalog();
}

function size(bytes) { return bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }

function enableControls(enabled) {
  document.querySelectorAll('[data-side], #labels, #mirror, #butterfly, #trace-layer, #net-walk, #favorite, #zoom-in, #zoom-out, #fit, #entity-search')
    .forEach(control => { control.disabled = !enabled; });
  $('board-summary').hidden = !enabled;
  $('file-details').hidden = !enabled;
  $('empty-view').hidden = enabled;
}

/** Mirrors the viewer's state into the toolbar; side buttons pause in butterfly. */
function syncViewControls() {
  const butterfly = viewer.layout === 'butterfly';
  document.querySelectorAll('[data-side]').forEach(button => {
    const active = !butterfly && Number(button.dataset.side) === viewer.side;
    button.classList.toggle('active', active);button.setAttribute('aria-pressed', String(active));
    button.disabled = butterfly || !state.board;
  });
  $('butterfly').checked = butterfly;
  $('mirror').checked = viewer.mirror;
  $('labels').checked = viewer.labels;
  $('trace-layer').value = viewer.traceLayer;
}

function setSide(side) {
  viewer.side = Number(side);
  syncViewControls();
  viewer.draw();renderEntities();
}

function revealWorkspace(id) {
  $('catalog-browser').hidden = true;$('workspace').hidden = false;$('browse-catalog').hidden = false;
  history.replaceState(null, '', `#board/${id}`);
}

async function openBoard(id) {
  opening?.abort();opening = new AbortController();
  const signal = opening.signal;
  try {
    if (tabs.all.some(tab => tab.id === id)) {
      revealWorkspace(id);
      await tabs.activate(id);
      return;
    }
    $('viewer-status').textContent = 'Platine wird geladen …';
    const data = await request(`/boards/${encodeURIComponent(id)}`, { signal });
    if (signal.aborted) return;
    await tabs.open({ id, title: data.metadata.title, board: data.board, metadata: data.metadata });
  } catch (error) {
    if (error.name === 'AbortError') return;
    notify(`Platine konnte nicht geöffnet werden: ${error.message}`, true);
    $('viewer-status').textContent = state.active ? 'Vorherige Platine geöffnet' : 'Laden fehlgeschlagen';
  }
}

/** Puts an activated tab's board into the viewer and every panel. */
function showBoard(tab) {
  const { id, board, metadata } = tab;
  revealWorkspace(id);
  state.board = board;
  $('import-notes').textContent = (board.parser_notes || []).join(' · ');
  $('import-notes').hidden = !board.parser_notes?.length;
  updateMetadata(metadata);
  enableControls(true);
  $('parts-count').textContent = number(metadata.parts_count);
  $('pins-count').textContent = number(metadata.pins_count);
  $('nets-count').textContent = number(metadata.nets_count);
  $('source-format').textContent = metadata.format.toUpperCase();
  $('parts-tab-count').textContent = number(metadata.parts_count);
  $('nets-tab-count').textContent = number(metadata.nets_count);
  $('entity-search').value = '';$('entity-search').rows = 1;
  state.limit = 250;
  $('trace-layer').replaceChildren(new Option('Leiterbahnen aus', ''));
  const layers = [...new Set([...(board.traces || []), ...(board.arcs || [])].map(trace => trace.layer))]
    .filter(layer => layer !== 28).sort((a, b) => a - b);
  if (layers.length) $('trace-layer').add(new Option('Alle Leiterbahnen', 'all'));
  layers.forEach(layer => $('trace-layer').add(new Option(`Ebene ${layer}`, String(layer))));
  viewer.setView({ side: 3, mirror: false, traceLayer: '', labels: viewer.labels, layout: 'single' });
  viewer.load(board);
  viewer.resize();viewer.fit();
  viewer.setView(tab.view);
  syncViewControls();
  renderEntities();
  renderSelection(null);
  $('download').href = `/api/library/boards/${encodeURIComponent(id)}/download`;
  $('download').setAttribute('download', metadata.filename);
  const b = viewer.bounds;
  $('viewer-status').textContent = 'Platine geladen';
  $('dimensions').textContent = `${((b.maxX - b.minX) * .0254).toFixed(1)} × ${((b.maxY - b.minY) * .0254).toFixed(1)} mm`;
  $('notification').hidden = true;
  worklist.load(id);
  schematic.setBoard(id, metadata.filename);
  if (compare.boardId === id && !$('part-compare').hidden) compare.reapplyHighlight();
}

function tabClosed(tab) {
  if (compare.boardId === tab.id || compare.otherId === tab.id) compare.hide();
  schematic.forget(tab.id);
  if (!tabs.all.length) clearBoard();
}

/** A board left the library: close its tab without saving its worklist. */
function dropBoard(id) {
  if (worklist.boardId === id) worklist.clear({ discard: true });
  tabs.close(id);
}

function focusPart(part) {
  if (!viewer.visible(part.layer)) setSide(part.layer);
  viewer.select({ kind: 'part', item: part }, true);
}

/** Selects the part or net a schematic token names on the shown board. */
function findOnBoard(token) {
  const name = token.toUpperCase();
  const part = state.board?.parts.find(candidate => candidate.refdes.toUpperCase() === name);
  if (part) { focusPart(part);return; }
  const net = state.board?.nets.find(candidate => candidate.name.toUpperCase() === name);
  if (net) viewer.select({ kind: 'net', item: net });
  else notify(`„${token}“ gibt es auf dieser Platine nicht.`);
}

function clearBoard() {
  state.active = null;state.board = null;
  $('import-notes').hidden = true;
  worklist.clear();compare.hide();schematic.setBoard(null);
  viewer.load(null);enableControls(false);renderCatalog();renderEntities();renderSelection(null);
  $('board-title').textContent = 'Dein nächster Blick ins Detail.';
  $('board-subtitle').textContent = 'Wähle eine Platine aus deiner Bibliothek.';
  $('parts-tab-count').textContent = '0';$('nets-tab-count').textContent = '0';
  $('viewer-status').textContent = 'Bereit für deine nächste Platine';
  $('dimensions').textContent = 'Mausrad: Zoom · Ziehen: Verschieben';
  history.replaceState(null, '', location.pathname + location.search);
  showBrowser();
}

async function importFiles(files) {
  if (state.busy) { notify('Ein Import läuft bereits. Bitte kurz warten.');return; }
  const selected = [...files];
  if (!selected.length) return;
  state.busy = true;$('import-button').disabled = true;$('empty-import').disabled = true;
  let lastId, added = 0, duplicates = 0;
  const errors = [];
  try {
    for (const [index, file] of selected.entries()) {
      notify(`Import ${index + 1}/${selected.length}: ${file.name} wird verarbeitet …`, false, true);
      try {
        if (state.maxUpload && file.size > state.maxUpload) throw new Error(`Datei zu groß (maximal ${Math.round(state.maxUpload / 1048576)} MB).`);
        const form = new FormData();form.append('file', file);
        const result = await request('/boards', { method: 'POST', body: form });
        lastId = result.board.id;
        if (result.duplicate) duplicates++; else added++;
      } catch (error) { errors.push(`${file.name}: ${error.message}`); }
    }
    await refresh();
    if (lastId) await openBoard(lastId);
    const status = [added ? `${added} Platine${added === 1 ? '' : 'n'} importiert.` : '',
      duplicates ? `${duplicates} Datei${duplicates === 1 ? ' ist' : 'en sind'} bereits in der Bibliothek.` : '', ...errors].filter(Boolean).join('\n');
    notify(status, Boolean(errors.length));
  } catch (error) { notify(error.message, true); }
  finally {
    state.busy = false;$('import-button').disabled = false;$('empty-import').disabled = false;
    $('file-input').value = '';
  }
}

function renderEntities() {
  const list = $('entity-list');list.replaceChildren();
  if (!state.board) { list.append(element('p', 'placeholder', 'Importiere eine Platine, um ihre Bauteile und Netze zu erkunden.'));return; }
  const query = parseQuery($('entity-search').value);
  const items = state.board[state.tab].filter(item => (state.tab === 'parts'
    ? viewer.visible(item.layer) && matchesPart(query, item) : matchesNet(query, item)));
  if (!items.length) list.append(element('p', 'placeholder', 'Keine Treffer. Ändere die Suche oder die Platinenseite.'));
  for (const item of items.slice(0, state.limit)) {
    const button = element('button', 'entity-row');button.type = 'button';
    const name = state.tab === 'parts' ? item.refdes : item.name;
    const detail = state.tab === 'parts' ? item.value || `${item.pin_refs.length} Pins` : `${item.pin_refs.length} Pins`;
    button.title = `${name} · ${detail}`;
    button.append(element('span', '', name), element('small', '', detail));
    button.addEventListener('click', () => {
      if (state.tab === 'parts') viewer.select({ kind: 'part', item }, true);
      else viewer.select({ kind: 'net', item });
    });
    list.append(button);
  }
  if (items.length > state.limit) {
    const more = element('button', 'text-button', `Weitere anzeigen (${number(state.limit)}/${number(items.length)})`);
    more.addEventListener('click', () => { state.limit += 250;renderEntities(); });list.append(more);
  }
}

function detail(parent, label, value) {
  if (value === null || value === undefined || value === '') return;
  const row = element('div', 'detail-row');
  row.append(element('span', '', label), element('span', '', String(value)));parent.append(row);
}

const sideName = layer => layer === 1 ? 'Oberseite' : layer === 2 ? 'Unterseite' : 'Beide Seiten';

function showPin(pin) {
  if (!viewer.visible(pin.layer)) setSide(pin.layer);
  viewer.center = { ...pin.pos };
  viewer.scale = Math.max(viewer.scale, viewer.baseScale * 6);
  viewer.select({ kind: 'pin', item: pin });
}

function appendPins(pins, container, start = 0) {
  pins.slice(start, start + 100).forEach(pin => {
    const row = element('button', 'pin-row');row.type = 'button';
    row.append(element('span', '', `${pin.part_refdes}.${pin.name || pin.index}`), element('span', '', pin.net || 'Nicht verbunden'));
    row.addEventListener('click', () => showPin(pin));container.append(row);
  });
  if (pins.length > start + 100) {
    const more = element('button', 'text-button', `Weitere Pins (${number(pins.length - start - 100)})`);
    more.addEventListener('click', () => { more.remove();appendPins(pins, container, start + 100); });container.append(more);
  }
}

function action(parent, label, handler) {
  const button = element('button', 'text-button', label);button.type = 'button';
  button.addEventListener('click', handler);parent.append(button);
}

function updateNeighbours() {
  const depth = Number($('net-walk').value);
  viewer.setExtraNets(depth && viewer.net ? adjacentNets(state.board, viewer.net, depth) : null);
}

function renderSelection(selection) {
  updateNeighbours();
  const container = $('selection');
  container.replaceChildren(element('span', 'eyebrow', 'AUSWAHL'));
  if (!selection) {
    container.append(element('p', 'placeholder', 'Klicke auf ein Bauteil oder einen Pin, um die Details zu sehen.'));return;
  }
  const item = selection.item;
  if (selection.kind === 'net') {
    container.append(element('h3', '', item.name));
    detail(container, 'Typ', item.is_ground ? 'Masse' : item.is_power ? 'Versorgung' : 'Signal');
    detail(container, 'Pins', number(item.pin_refs.length));
    detail(container, 'Sollspannung', item.expected_voltage_v != null ? `${item.expected_voltage_v} V` : null);
    detail(container, 'Sollwiderstand', item.expected_open ? 'Offen / OL' : item.expected_resistance_ohms != null ? `${item.expected_resistance_ohms} Ω` : null);
    action(container, 'Im Schaltplan suchen →', () => schematic.search(item.name));
    appendPins(item.pin_refs.map(index => state.board.pins[index]).filter(Boolean), container);
  } else if (selection.kind === 'part') {
    container.append(element('h3', '', item.refdes));
    if (item.placement_inferred) detail(container, 'Position', 'Aus Leiterbahnen geschätzt – nicht direkt in der Datei gespeichert');
    detail(container, 'Importhinweis', item.import_note);
    detail(container, 'Wert', item.value);detail(container, 'Gehäuse', item.footprint);
    detail(container, 'Seite', sideName(item.layer));detail(container, 'Pins', number(item.pin_refs.length));
    detail(container, 'Drehung', item.rotation_deg != null ? `${item.rotation_deg}°` : null);
    if (item.is_dnp) detail(container, 'Bestückung', 'Nicht bestückt (DNP)');
    action(container, 'Auf die Arbeitsliste →', () => worklist.add(item.refdes));
    action(container, 'Pinbelegung vergleichen →', () => compare.show(state.active.id, item.refdes));
    action(container, 'Im Schaltplan suchen →', () => schematic.search(item.refdes));
    appendPins(item.pin_refs.map(index => state.board.pins[index]).filter(Boolean), container);
  } else {
    container.append(element('h3', '', `${item.part_refdes}.${item.name || item.index}`));
    detail(container, 'Seite', sideName(item.layer));
    detail(container, 'Position', `${(item.pos.x * .0254).toFixed(3)}, ${(item.pos.y * .0254).toFixed(3)} mm`);
    detail(container, 'Netz', item.net || 'Nicht verbunden');
    if (item.net) {
      const net = state.board.nets.find(net => net.name === item.net);
      if (net) {
        const button = element('button', 'text-button', `Netz inspizieren (${number(net.pin_refs.length)} Pins) →`);
        button.addEventListener('click', () => viewer.select({ kind: 'net', item: net }));container.append(button);
      }
      action(container, 'Im Schaltplan suchen →', () => schematic.search(item.net));
    }
    const part = state.board.parts.find(part => part.refdes === item.part_refdes);
    if (part) {
      const button = element('button', 'text-button', `Bauteil ${part.refdes} ansehen →`);
      button.addEventListener('click', () => viewer.select({ kind: 'part', item: part }));container.append(button);
    }
  }
}

$('import-button').addEventListener('click', () => $('file-input').click());
$('empty-import').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', event => importFiles(event.target.files));
$('library-search').addEventListener('input', renderCatalog);
$('sort').addEventListener('change', renderCatalog);
$('refresh').addEventListener('click', () => refresh().catch(error => notify(error.message, true)));
for (const [id, favorites] of [['all-filter', false], ['favorites-filter', true]]) {
  $(id).addEventListener('click', () => {
    state.favorites = favorites;
    $('all-filter').classList.toggle('active', !favorites);$('all-filter').setAttribute('aria-pressed', String(!favorites));
    $('favorites-filter').classList.toggle('active', favorites);$('favorites-filter').setAttribute('aria-pressed', String(favorites));
    renderCatalog();
  });
}
document.querySelectorAll('[data-side]').forEach(button => button.addEventListener('click', () => setSide(button.dataset.side)));
function selectPanel(name) {
  state.panel = name;
  const entities = name === 'parts' || name === 'nets';
  document.querySelectorAll('[data-tab]').forEach(tab => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('active', active);tab.setAttribute('aria-pressed', String(active));
  });
  for (const id of ['entity-search-box', 'entity-list', 'selection']) $(id).hidden = !entities;
  $('worklist-panel').hidden = name !== 'worklist';
  $('colors-panel').hidden = name !== 'colors';
  if (!entities) return;
  state.tab = name;state.limit = 250;
  $('entity-search').placeholder = name === 'parts' ? 'Bauteil oder Wert suchen …' : 'Netz suchen …';
  $('entity-search').setAttribute('aria-label', `${name === 'parts' ? 'Bauteile' : 'Netze'} durchsuchen, jede Zeile filtert weiter`);
  renderEntities();
}
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => selectPanel(button.dataset.tab)));
document.addEventListener('keydown', event => {
  if (!event.altKey || event.code !== 'KeyL' || !state.board) return;
  event.preventDefault();
  selectPanel(state.panel === 'worklist' ? state.tab : 'worklist');
  if (state.panel === 'worklist') worklist.input.focus();
});
$('entity-search').addEventListener('input', event => {
  event.target.rows = Math.min(5, event.target.value.split('\n').length);
  state.limit = 250;renderEntities();
});
$('labels').addEventListener('change', event => { viewer.labels = event.target.checked;viewer.draw(); });
$('mirror').addEventListener('change', event => { viewer.mirror = event.target.checked;viewer.draw(); });
$('butterfly').addEventListener('change', event => {
  viewer.layout = event.target.checked ? 'butterfly' : 'single';
  syncViewControls();renderEntities();
});
$('net-walk').addEventListener('change', updateNeighbours);
$('trace-layer').addEventListener('change', event => { viewer.traceLayer = event.target.value;viewer.draw(); });
$('board-canvas').addEventListener('contextmenu', event => {
  if (!state.board) return;
  event.preventDefault();
  const rect = event.currentTarget.getBoundingClientRect();
  viewer.pick(viewer.world({ x: event.clientX - rect.left, y: event.clientY - rect.top }));
  const term = viewer.selected?.kind === 'part' ? viewer.selected.item.refdes : viewer.net;
  if (term) schematic.search(term);
});
$('zoom-in').addEventListener('click', () => viewer.zoom(1.4));
$('zoom-out').addEventListener('click', () => viewer.zoom(1 / 1.4));
$('fit').addEventListener('click', () => viewer.fit());
$('favorite').addEventListener('click', async () => {
  const current = state.active;
  if (!current) return;
  $('favorite').disabled = true;
  try {
    const updated = await request(`/boards/${current.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: !current.favorite }) });
    if (state.active?.id === current.id) updateMetadata(updated); else await refresh();
  } catch (error) { notify(error.message, true); }
  finally { $('favorite').disabled = !state.active; }
});
$('metadata-form').addEventListener('submit', async event => {
  event.preventDefault();
  const current = state.active;
  if (!current) return;
  const button = event.submitter;button.disabled = true;
  try {
    const updated = await request(`/boards/${current.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: $('edit-title').value, notes: $('edit-notes').value }) });
    if (state.active?.id === current.id) updateMetadata(updated); else await refresh();
    notify('Name und Notizen gespeichert.');
  } catch (error) { notify(error.message, true); }
  finally { button.disabled = false; }
});
$('delete').addEventListener('click', () => {
  if (!state.active) return;
  $('delete-dialog').dataset.boardId = state.active.id;
  $('delete-description').textContent = `„${state.active.title}“ mit Originaldatei und Notizen wird dauerhaft vom Server entfernt.`;
  $('delete-dialog').returnValue = '';$('delete-dialog').showModal();
});
$('delete-dialog').addEventListener('close', async () => {
  if ($('delete-dialog').returnValue !== 'delete') return;
  const id = $('delete-dialog').dataset.boardId;
  try {
    await request(`/boards/${id}`, { method: 'DELETE' });
    dropBoard(id);
    await refresh();notify('Platine aus der Bibliothek gelöscht.');
  } catch (error) { notify(error.message, true); }
});

let dragDepth = 0;
document.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
document.addEventListener('drop', event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();dragDepth = 0;$('drag-overlay').hidden = true;
  importFiles(event.dataTransfer.files);
});
$('drop-zone').addEventListener('dragenter', event => {
  if (event.dataTransfer.types.includes('Files')) { dragDepth++;$('drag-overlay').hidden = false; }
});
$('drop-zone').addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1);if (!dragDepth) $('drag-overlay').hidden = true; });
window.addEventListener('hashchange', () => {
  const id = location.hash.match(/^#board\/([a-f0-9]{64})$/)?.[1];
  if (id && (id !== state.active?.id || $('workspace').hidden)) openBoard(id);
  else if (!id) { catalog.syncFromHash();showBrowser(); }
});

(async function init() {
  try {
    const [info] = await Promise.all([request(''), refresh(), catalog.init()]);
    state.maxUpload = info.max_upload_bytes;
    $('file-input').accept = info.extensions.join(',');
    $('formats').textContent = `${info.extensions.length} Dateiformate · max. ${Math.round(info.max_upload_bytes / 1048576)} MB / Datei`;
    const id = location.hash.match(/^#board\/([a-f0-9]{64})$/)?.[1];
    if (id) await openBoard(id);
  } catch (error) {
    $('formats').textContent = 'Server nicht erreichbar';
    notify(`Bibliothek konnte nicht geladen werden: ${error.message}`, true);
  }
})();

window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  opening?.abort();
  catalog.controller?.abort();
  clearTimeout(catalog.searchTimer);
  clearTimeout(notificationTimer);
  schematic.dispose();
  colorRules.dispose();
  tabs.destroy();
  viewer.dispose();
});

$('offline-save').onclick = async () => {
  if (!state.board) { notify('Bitte zuerst eine Platine öffnen.'); return; }
  $('offline-save').disabled = true;
  try { await saveOffline(state.board); notify('Offline gespeichert. Unter Einstellungen → Offline-Bibliothek öffnen.'); }
  catch(error) { notify(error.message, true); }
  finally { $('offline-save').disabled = false; }
};
