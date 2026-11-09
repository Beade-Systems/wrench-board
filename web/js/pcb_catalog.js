// Folder browser and paginated file grid. Only the chosen board is parsed/imported.
import { FolderTree, folderSummary } from './pcb_catalog_folders.js';

const $ = id => document.getElementById(id);
const count = value => new Intl.NumberFormat('de-DE').format(value);
const labels = { Computers: 'Computer', Phones: 'Smartphones', 'Game Consoles': 'Konsolen', Drones: 'Drohnen' };
const folderHash = path => (path ? `#folder/${path.split('/').map(encodeURIComponent).join('/')}` : '#catalog');
const MAX_VISIBLE_REVISIONS = 8;

/** Revision names without the text they all share, cut back to a separator. */
function revisionLabels(names) {
  let prefix = names[0];
  for (const name of names) while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
  prefix = prefix.replace(/[^-_ ]*$/, '');
  return names.map(name => name.slice(prefix.length) || name);
}

function folderFromHash() {
  const match = location.hash.match(/^#folder\/(.+)$/);
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch { return ''; }
}
const kinds = { board: 'Boardview', pdf: 'PDF-Dokument', archive: 'Archiv', other: 'Datei' };
const icons = { board: '▦', pdf: '▤', archive: '▣', other: '◇' };

function node(tag, className, text) {
  const result = document.createElement(tag);result.className = className || '';
  if (text !== undefined) result.textContent = text;
  return result;
}

function fileSize(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export class CatalogBrowser {
  constructor({ request, notify, openBoard, getBoards }) {
    Object.assign(this, { request, notify, openBoard, getBoards });
    this.mode = 'source';this.offset = 0;this.limit = 60;this.total = 0;
    this.folder = folderFromHash();this.listings = new Map();
    this.tree = new FolderTree($('folder-tree'), { list: path => this.listing(path), onSelect: path => this.goTo(path),
      kind: () => $('source-kind').value, displayName: label => labels[label] || label });
    $('source-search').addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      // Cancel an old response immediately, before the debounce expires.
      this.controller?.abort();
      this.searchTimer = setTimeout(() => { this.offset = 0;this.load(); }, 220);
    });
    $('source-kind').addEventListener('change', () => { this.offset = 0;this.tree.reset();this.load(); });
    $('source-sort').addEventListener('change', () => { this.offset = 0;this.load(); });
    $('source-prev').addEventListener('click', () => this.page(-1));
    $('source-next').addEventListener('click', () => this.page(1));
    $('source-tab').addEventListener('click', () => this.setMode('source'));
    $('imports-tab').addEventListener('click', () => this.setMode('imports'));
    $('source-reset').addEventListener('click', () => {
      $('source-search').value = '';$('source-kind').value = 'board';this.offset = 0;
      this.tree.reset();this.load();
    });
    $('source-refresh').addEventListener('click', () => this.refreshIndex());
  }

  async init() {
    try {
      this.info = await this.request('/source');
      this.renderInfo();
      if (!this.info.available) this.setMode('imports'); else await this.load();
    } catch (error) {
      this.fail(error);
    }
  }

  renderInfo() {
    const info = this.info;
    $('source-description').textContent = info.available
      ? `${count(info.total)} Dateien aus ${info.name}. Suche dein Modell und öffne die passende Datei.`
      : 'Der Ordner xzz_downloads ist nicht verfügbar. Deine importierten Platinen findest du hier.';
    $('source-tab').disabled = !info.available;
    $('source-refresh').hidden = !info.available || this.mode !== 'source';
    $('source-stats').replaceChildren();
    if (info.available) {
      for (const [kind, label] of [['board', 'Boardviews'], ['pdf', 'PDFs'], ['archive', 'Archive']]) {
        const item = node('div', 'source-stat');
        item.append(node('strong', '', count(info.kinds[kind] || 0)), node('span', '', label));
        $('source-stats').append(item);
      }
    }
    this.updateImports();
  }

  hash() { return folderHash(this.folder); }

  /** Navigates through the URL, so the browser's back button walks the folders. */
  goTo(path) {
    const target = folderHash(path);
    if (location.hash === target) this.show(path); else location.hash = target;
  }

  syncFromHash() {
    const path = folderFromHash();
    if (path !== this.folder && !location.hash.startsWith('#board/')) this.show(path);
  }

  show(path) {
    this.folder = path;this.offset = 0;
    $('source-search').value = '';
    this.load();
  }

  listing(path) {
    const kind = $('source-kind').value;
    const key = `${kind}\0${path}`;
    let result = this.listings.get(key);
    if (!result) {
      const params = new URLSearchParams({ path, kind });
      result = this.request(`/source/folders?${params}`);
      result.catch(() => this.listings.delete(key));
      this.listings.set(key, result);
    }
    return result;
  }

  renderFolders(listing, searching) {
    const path = $('folder-path');
    path.replaceChildren(...listing.breadcrumbs.flatMap((crumb, index, all) => {
      const last = index === all.length - 1;
      const item = node(last ? 'span' : 'button', last ? 'folder-crumb current' : 'folder-crumb', labels[crumb.label] || crumb.label);
      if (last) item.setAttribute('aria-current', 'page');
      else { item.type = 'button';item.addEventListener('click', () => this.goTo(crumb.path)); }
      return index ? [node('span', 'folder-separator', '/'), item] : [item];
    }));
    const grid = $('folder-grid');
    grid.hidden = searching || !listing.folders.length;
    grid.replaceChildren(...(searching ? [] : listing.folders.map(folder => this.folderCard(folder))));
    $('source-search').placeholder = `In ${labels[listing.label] || listing.label} suchen …`;
  }

  folderCard(folder) {
    const card = node('button', 'folder-card');
    card.type = 'button';card.title = folder.name;
    const copy = node('div', 'folder-card-copy');
    copy.append(node('strong', '', labels[folder.label] || folder.label), node('small', '', folderSummary(folder, count)));
    card.append(node('span', 'folder-card-icon', '▸'), copy);
    card.addEventListener('click', () => this.goTo(folder.path));
    return card;
  }

  updateImports() {
    $('imports-count').textContent = count(this.getBoards().length);
    if (this.mode === 'imports') this.load();
  }

  setMode(mode) {
    this.mode = mode;this.offset = 0;
    $('source-tab').classList.toggle('active', mode === 'source');$('source-tab').setAttribute('aria-pressed', String(mode === 'source'));
    $('imports-tab').classList.toggle('active', mode === 'imports');$('imports-tab').setAttribute('aria-pressed', String(mode === 'imports'));
    $('source-kind').hidden = mode !== 'source';
    $('source-refresh').hidden = mode !== 'source' || !this.info?.available;
    for (const id of ['folder-tree', 'folder-path', 'folder-grid']) $(id).hidden = mode !== 'source';
    $('source-hint').textContent = mode === 'source' ? 'Platinen öffnen · PDFs ansehen · Archive herunterladen' : 'Importierte Platinen mit einem Klick öffnen.';
    if (mode !== 'source') $('source-search').placeholder = 'In meinen Importen suchen …';
    this.load();
  }

  async refreshIndex() {
    const button = $('source-refresh');button.disabled = true;button.textContent = 'Ordner wird eingelesen …';
    try {
      this.info = await this.request('/source/refresh', { method: 'POST' });
      this.offset = 0;this.listings.clear();this.tree.reset();
      this.renderInfo();await this.load();this.notify('Dateikatalog aktualisiert.');
    } catch (error) { this.notify(error.message, true); }
    finally { button.disabled = false;button.textContent = '↻ Ordner neu einlesen'; }
  }

  page(direction) {
    this.offset = Math.max(0, this.offset + direction * this.limit);
    this.load();$('catalog-browser').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async load() {
    this.controller?.abort();this.controller = new AbortController();
    const signal = this.controller.signal;
    $('source-grid').setAttribute('aria-busy', 'true');$('source-results').textContent = 'Dateien werden gesucht …';
    $('source-prev').disabled = true;$('source-next').disabled = true;
    try {
      let result, listing = null;
      const query = $('source-search').value.trim();
      if (this.mode === 'imports') {
        const words = $('source-search').value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const boards = this.getBoards().filter(board => words.every(word => `${board.title} ${board.filename} ${board.notes}`.toLocaleLowerCase().includes(word)));
        const sort = $('source-sort').value;
        boards.sort(sort === 'recent' ? (a, b) => b.imported_at.localeCompare(a.imported_at) : sort === 'size' ? (a, b) => b.size_bytes - a.size_bytes
          : (a, b) => a.title.localeCompare(b.title, 'de', { numeric: true }));
        result = { total: boards.length, items: boards.slice(this.offset, this.offset + this.limit).map(board => ({
          id: board.id, name: board.title, path: board.filename, category: 'Meine Importe', extension: `.${board.format}`,
          kind: 'board', size_bytes: board.size_bytes, imported: true, favorite: board.favorite,
        })) };
      } else {
        const params = new URLSearchParams({ q: $('source-search').value, kind: $('source-kind').value,
          folder: this.folder, recursive: String(Boolean(query)),
          group: String(!query && $('source-kind').value === 'board'), sort: $('source-sort').value,
          offset: String(this.offset), limit: String(this.limit) });
        [result, listing] = await Promise.all([this.request(`/source/files?${params}`, { signal }), this.listing(this.folder)]);
      }
      if (signal.aborted) return;
      this.total = result.total;
      if (listing) { this.renderFolders(listing, Boolean(query));this.tree.reveal(this.folder); }
      $('source-grid').replaceChildren(...result.items.map(item => this.card(item)));
      const subfolders = listing && !query ? listing.folders.length : 0;
      $('source-empty').hidden = Boolean(result.items.length || subfolders);
      $('source-empty-text').textContent = this.mode === 'imports' && !this.getBoards().length
        ? 'Öffne eine Platine aus xzz_downloads oder importiere eine eigene Datei.'
        : 'Versuche einen anderen Modellnamen oder ändere die Filter.';
      const scope = listing && this.folder ? ` in ${labels[listing.label] || listing.label}` : '';
      const fileCount = result.files ?? result.total;
      const files = `${count(fileCount)} ${fileCount === 1 ? 'Datei' : 'Dateien'}${result.files > result.total ? ` · ${count(result.total)} Boards` : ''}`;
      $('source-results').textContent = query ? `${files} für „${query}“${scope}`
        : subfolders ? `${count(subfolders)} Ordner${result.total ? ` · ${files} direkt hier` : ''}` : `${files}${scope}`;
      $('source-page').textContent = result.total ? `${count(this.offset + 1)}–${count(Math.min(this.offset + this.limit, result.total))} von ${count(result.total)}` : 'Keine Ergebnisse';
      $('source-prev').disabled = this.offset === 0;$('source-next').disabled = this.offset + this.limit >= result.total;
      $('source-pagination').hidden = result.total <= this.limit;
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (this.mode === 'source' && this.folder) {
        // A stale link to a folder that is gone falls back to the top level.
        this.notify(`Ordner konnte nicht geöffnet werden: ${error.message}`, true);
        this.goTo('');
        return;
      }
      this.fail(error);
    } finally {
      if (!signal.aborted) $('source-grid').setAttribute('aria-busy', 'false');
    }
  }

  /** One card per board number, with a directly clickable chip per revision. */
  groupCard(item) {
    const card = node('div', 'source-card source-group');
    const visual = node('div', 'source-card-visual');
    visual.append(node('span', 'source-file-icon', icons.board), node('span', 'source-extension', `${item.revisions.length} REV`));
    const copy = node('div', 'source-card-copy');
    const identity = [...new Set([item.brand, item.model].filter(Boolean))].filter(text => text !== item.board_number).join(' · ');
    copy.append(node('h2', '', item.board_number));
    if (identity) copy.append(node('p', 'source-card-identity', identity));
    const chips = node('div', 'revision-chips');
    const names = item.revisions.map(revision => revision.name.slice(0, -revision.extension.length));
    const texts = revisionLabels(names);
    const add = (start, end) => item.revisions.slice(start, end).forEach((revision, offset) => {
      const chip = node('button', 'revision-chip', texts[start + offset]);
      chip.type = 'button';chip.title = revision.name;
      chip.addEventListener('click', () => this.open(revision, chip));
      chips.append(chip);
    });
    add(0, MAX_VISIBLE_REVISIONS);
    if (item.revisions.length > MAX_VISIBLE_REVISIONS) {
      const more = node('button', 'revision-chip more', `+${item.revisions.length - MAX_VISIBLE_REVISIONS}`);
      more.type = 'button';
      more.addEventListener('click', () => { more.remove();add(MAX_VISIBLE_REVISIONS, item.revisions.length); });
      chips.append(more);
    }
    copy.append(chips);
    card.append(visual, copy);
    return card;
  }

  card(item) {
    if (item.revisions) return this.groupCard(item);
    const board = item.kind === 'board';
    const card = node(board ? 'button' : 'a', `source-card kind-${item.kind}`);
    card.title = item.path;
    if (board) {
      card.type = 'button';card.addEventListener('click', () => this.open(item, card));
    } else {
      card.href = `/api/library/source/files/${item.id}/download${item.kind === 'pdf' ? '?inline=true' : ''}`;
      if (item.kind === 'pdf') { card.target = '_blank';card.rel = 'noopener'; }
      else card.setAttribute('download', item.name);
    }
    const visual = node('div', 'source-card-visual');
    visual.append(node('span', 'source-file-icon', icons[item.kind]), node('span', 'source-extension', item.extension.replace('.', '').toUpperCase()));
    const copy = node('div', 'source-card-copy');
    const title = item.imported ? item.name : item.name.slice(0, -item.extension.length);
    copy.append(node('h2', '', title));
    const within = this.folder && item.path.startsWith(`${this.folder}/`) ? item.path.slice(this.folder.length + 1) : item.path;
    const relativeFolder = within.split('/').slice(0, -1).join(' / ');
    if (relativeFolder) copy.append(node('p', 'source-card-path', relativeFolder));
    const identity = [...new Set([item.brand, item.model, item.board_number].filter(Boolean))].join(' · ');
    if (identity) copy.append(node('p', 'source-card-identity', identity));
    const footer = node('div', 'source-card-footer');
    footer.append(node('span', '', `${kinds[item.kind]} · ${fileSize(item.size_bytes)}`),
      node('span', 'source-card-action', board ? 'Öffnen ↗' : item.kind === 'pdf' ? 'Ansehen ↗' : 'Laden ↓'));
    card.append(visual, copy, footer);
    return card;
  }

  async open(item, card) {
    if (this.opening) { this.notify('Eine Platine wird gerade geöffnet. Bitte kurz warten.');return; }
    this.opening = true;card.disabled = true;card.classList.add('opening');
    const action = card.querySelector('.source-card-action');
    if (action) action.textContent = 'Lädt …';
    this.notify(`${item.name} wird geöffnet …`, false, true);
    try {
      let id = item.id;
      if (!item.imported) {
        const result = await this.request(`/source/files/${item.id}/open`, { method: 'POST' });
        id = result.board.id;
      }
      await this.openBoard(id);
    } catch (error) { this.notify(`Datei konnte nicht geöffnet werden: ${error.message}`, true); }
    finally { this.opening = false;card.disabled = false;card.classList.remove('opening');if (action) action.textContent = 'Öffnen ↗'; }
  }

  fail(error) {
    $('source-grid').replaceChildren();$('source-grid').setAttribute('aria-busy', 'false');
    $('source-results').textContent = 'Katalog konnte nicht geladen werden.';
    $('source-page').textContent = '';
    this.notify(error.message, true);
  }
}
