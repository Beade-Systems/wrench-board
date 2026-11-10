// Folder browser and paginated file grid. Only the chosen board is parsed/imported.
import { FolderTree, folderSummary } from './pcb_catalog_folders.js';

const $ = id => document.getElementById(id);
// Falls back to the English literal when i18n is absent or dictionaries aren't loaded.
const fill = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text);
const tr = (key, fallback, params) => {
  const translate = window.i18n?.t ?? window.t;
  const text = typeof translate === 'function' ? translate(key, params) : key;
  return text === key ? fill(fallback, params) : text;
};
const intlTag = () => window.i18n?.intlTag || 'en-US';
const count = value => new Intl.NumberFormat(intlTag()).format(value);
// Top-level folders of the stock collection carry English names; others show as they are.
const CATEGORY_KEYS = { Computers: 'computers', Phones: 'phones', 'Game Consoles': 'game_consoles', Drones: 'drones' };
const displayLabel = label => (CATEGORY_KEYS[label] ? tr(`library.catalog.category.${CATEGORY_KEYS[label]}`, label) : label);
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
const KIND_FALLBACK = { board: 'Boardview', pdf: 'PDF document', archive: 'Archive', other: 'File' };
const kindName = kind => tr(`library.catalog.kind_one.${kind}`, KIND_FALLBACK[kind] || kind);
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
      kind: () => $('source-kind').value, displayName: displayLabel });
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
    // This module owns these texts from here on; applyDom() must not reset them.
    for (const id of ['source-tab', 'source-description', 'source-results', 'source-hint', 'source-empty-text', 'source-refresh']) $(id).removeAttribute('data-i18n');
    $('source-search').removeAttribute('data-i18n-attr');
    $('source-search').setAttribute('aria-label', tr('library.catalog.search_aria', 'Search the file grid'));
    $('source-tab').textContent = info.name || tr('library.catalog.source_default', 'Linked collection');
    $('source-description').textContent = info.available
      ? tr('library.catalog.description', '{count} files from {name}. Search for your model and open the matching file.', { count: count(info.total), name: info.name })
      : tr('library.catalog.unavailable', 'No collection available. Link a folder in the settings. Your imports are listed here.');
    $('source-tab').disabled = !info.available;
    $('source-refresh').hidden = !info.available || this.mode !== 'source';
    $('source-stats').replaceChildren();
    if (info.available) {
      for (const [kind, label] of [['board', tr('library.catalog.stat.boards', 'Boardviews')], ['pdf', tr('library.catalog.stat.pdfs', 'PDFs')], ['archive', tr('library.catalog.stat.archives', 'Archives')]]) {
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
      const item = node(last ? 'span' : 'button', last ? 'folder-crumb current' : 'folder-crumb', displayLabel(crumb.label));
      if (last) item.setAttribute('aria-current', 'page');
      else { item.type = 'button';item.addEventListener('click', () => this.goTo(crumb.path)); }
      return index ? [node('span', 'folder-separator', '/'), item] : [item];
    }));
    const grid = $('folder-grid');
    grid.hidden = searching || !listing.folders.length;
    grid.replaceChildren(...(searching ? [] : listing.folders.map(folder => this.folderCard(folder))));
    $('source-search').placeholder = tr('library.catalog.search_in', 'Search in {folder} …', { folder: displayLabel(listing.label) });
  }

  folderCard(folder) {
    const card = node('button', 'folder-card');
    card.type = 'button';card.title = folder.name;
    const copy = node('div', 'folder-card-copy');
    copy.append(node('strong', '', displayLabel(folder.label)), node('small', '', folderSummary(folder, count)));
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
    this.renderModeTexts();
    this.load();
  }

  renderModeTexts() {
    $('source-hint').removeAttribute('data-i18n');
    $('source-hint').textContent = this.mode === 'source'
      ? tr('library.catalog.hint_source', 'Open boards · view PDFs · download archives')
      : tr('library.catalog.hint_imports', 'Open imported boards with one click.');
    if (this.mode !== 'source') {
      $('source-search').removeAttribute('data-i18n-attr');
      $('source-search').setAttribute('aria-label', tr('library.catalog.search_aria', 'Search the file grid'));
      $('source-search').placeholder = tr('library.catalog.search_imports', 'Search my imports …');
    }
  }

  /** Re-renders every text this browser wrote, after dictionaries load or the locale switches. */
  relocalize() {
    if (this.info) this.renderInfo();
    if (this._failed) { this.renderFailure();return; }
    if (!this.info) return;
    this.renderModeTexts();
    this.listings.clear();this.tree.reset();
    if (this.mode === 'source') this.load();
  }

  async refreshIndex() {
    const button = $('source-refresh');button.disabled = true;button.textContent = tr('library.catalog.rescanning', 'Reading folder …');
    try {
      this.info = await this.request('/source/refresh', { method: 'POST' });
      this.offset = 0;this.listings.clear();this.tree.reset();
      this.renderInfo();await this.load();this.notify(tr('library.catalog.refreshed', 'File catalog updated.'));
    } catch (error) { this.notify(error.message, true); }
    finally { button.disabled = false;button.textContent = tr('library.catalog.rescan', '↻ Rescan folder'); }
  }

  page(direction) {
    this.offset = Math.max(0, this.offset + direction * this.limit);
    this.load();$('catalog-browser').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async load() {
    this.controller?.abort();this.controller = new AbortController();
    const signal = this.controller.signal;
    this._failed = false;
    $('source-results').removeAttribute('data-i18n');
    $('source-grid').setAttribute('aria-busy', 'true');$('source-results').textContent = tr('library.catalog.searching', 'Searching files …');
    $('source-prev').disabled = true;$('source-next').disabled = true;
    try {
      let result, listing = null;
      const query = $('source-search').value.trim();
      if (this.mode === 'imports') {
        const words = $('source-search').value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const boards = this.getBoards().filter(board => words.every(word => `${board.title} ${board.filename} ${board.notes}`.toLocaleLowerCase().includes(word)));
        const sort = $('source-sort').value;
        boards.sort(sort === 'recent' ? (a, b) => b.imported_at.localeCompare(a.imported_at) : sort === 'size' ? (a, b) => b.size_bytes - a.size_bytes
          : (a, b) => a.title.localeCompare(b.title, intlTag(), { numeric: true }));
        result = { total: boards.length, items: boards.slice(this.offset, this.offset + this.limit).map(board => ({
          id: board.id, name: board.title, path: board.filename, category: tr('library.catalog.my_imports', 'My imports'), extension: `.${board.format}`,
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
      $('source-empty-text').removeAttribute('data-i18n');
      $('source-empty-text').textContent = this.mode === 'imports' && !this.getBoards().length
        ? tr('library.catalog.empty_imports', 'Open a board from the collection or import a file of your own.')
        : tr('library.catalog.empty_text', 'Try a different model name or change the filters.');
      const folder = listing && this.folder ? displayLabel(listing.label) : '';
      const fileCount = result.files ?? result.total;
      let files = fileCount === 1 ? tr('library.catalog.files_one', '1 file') : tr('library.catalog.files_other', '{count} files', { count: count(fileCount) });
      if (result.files > result.total) files += ` · ${tr('library.catalog.boards_count', '{count} boards', { count: count(result.total) })}`;
      const folders = subfolders === 1 ? tr('library.catalog.folders_one', '1 folder') : tr('library.catalog.folders_other', '{count} folders', { count: count(subfolders) });
      let summary;
      if (query) {
        summary = folder ? tr('library.catalog.results_query_in', '{files} for “{query}” in {folder}', { files, query, folder })
          : tr('library.catalog.results_query', '{files} for “{query}”', { files, query });
      } else if (subfolders) {
        summary = result.total ? tr('library.catalog.results_folders_files', '{folders} · {files} directly here', { folders, files }) : folders;
      } else {
        summary = folder ? tr('library.catalog.results_in', '{files} in {folder}', { files, folder }) : files;
      }
      $('source-results').textContent = summary;
      $('source-page').textContent = result.total
        ? tr('library.catalog.page_range', '{from}–{to} of {total}', { from: count(this.offset + 1), to: count(Math.min(this.offset + this.limit, result.total)), total: count(result.total) })
        : tr('library.catalog.no_results', 'No results');
      $('source-prev').disabled = this.offset === 0;$('source-next').disabled = this.offset + this.limit >= result.total;
      $('source-pagination').hidden = result.total <= this.limit;
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (this.mode === 'source' && this.folder) {
        // A stale link to a folder that is gone falls back to the top level.
        this.notify(tr('library.catalog.folder_open_failed', 'The folder could not be opened: {message}', { message: error.message }), true);
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
    footer.append(node('span', '', `${kindName(item.kind)} · ${fileSize(item.size_bytes)}`),
      node('span', 'source-card-action', board ? tr('library.catalog.action_open', 'Open ↗')
        : item.kind === 'pdf' ? tr('library.catalog.action_view', 'View ↗') : tr('library.catalog.action_download', 'Download ↓')));
    card.append(visual, copy, footer);
    return card;
  }

  async open(item, card) {
    if (this.opening) { this.notify(tr('library.catalog.opening_busy', 'A board is being opened. Please wait a moment.'));return; }
    this.opening = true;card.disabled = true;card.classList.add('opening');
    const action = card.querySelector('.source-card-action');
    if (action) action.textContent = tr('library.catalog.action_loading', 'Loading …');
    this.notify(tr('library.catalog.opening', 'Opening {name} …', { name: item.name }), false, true);
    try {
      let id = item.id;
      if (!item.imported) {
        const result = await this.request(`/source/files/${item.id}/open`, { method: 'POST' });
        id = result.board.id;
      }
      await this.openBoard(id);
    } catch (error) { this.notify(tr('library.catalog.file_open_failed', 'The file could not be opened: {message}', { message: error.message }), true); }
    finally { this.opening = false;card.disabled = false;card.classList.remove('opening');if (action) action.textContent = tr('library.catalog.action_open', 'Open ↗'); }
  }

  fail(error) {
    $('source-grid').replaceChildren();$('source-grid').setAttribute('aria-busy', 'false');
    this._failed = true;
    this.renderFailure();
    $('source-page').textContent = '';
    this.notify(error.message, true);
  }

  renderFailure() {
    $('source-results').removeAttribute('data-i18n');
    $('source-results').textContent = tr('library.catalog.load_failed', 'The catalog could not be loaded.');
  }
}
