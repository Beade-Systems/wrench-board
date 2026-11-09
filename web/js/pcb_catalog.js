// Paginated source-file grid. Only the chosen board is parsed/imported.
const $ = id => document.getElementById(id);
const count = value => new Intl.NumberFormat('de-DE').format(value);
const labels = { Computers: 'Computer', Phones: 'Smartphones', 'Game Consoles': 'Konsolen', Drones: 'Drohnen' };
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
    this.mode = 'source';this.offset = 0;this.limit = 60;this.category = '';this.total = 0;
    $('source-search').addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      // Cancel an old response immediately, before the debounce expires.
      this.controller?.abort();
      this.searchTimer = setTimeout(() => { this.offset = 0;this.load(); }, 220);
    });
    for (const id of ['source-kind', 'source-sort']) $(id).addEventListener('change', () => { this.offset = 0;this.load(); });
    $('source-prev').addEventListener('click', () => this.page(-1));
    $('source-next').addEventListener('click', () => this.page(1));
    $('source-tab').addEventListener('click', () => this.setMode('source'));
    $('imports-tab').addEventListener('click', () => this.setMode('imports'));
    $('source-reset').addEventListener('click', () => {
      $('source-search').value = '';$('source-kind').value = 'board';this.category = '';this.offset = 0;
      this.renderCategories();this.load();
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
    this.renderCategories();this.updateImports();
  }

  renderCategories() {
    const container = $('source-categories');container.replaceChildren();
    container.hidden = this.mode !== 'source';
    for (const category of [{ name: '', count: this.info?.total || 0 }, ...(this.info?.categories || [])]) {
      const button = node('button', `category-filter${category.name === this.category ? ' active' : ''}`);
      button.type = 'button';button.setAttribute('aria-pressed', String(category.name === this.category));
      button.append(node('span', '', labels[category.name] || category.name || 'Alle Kategorien'), node('small', '', count(category.count)));
      button.addEventListener('click', () => { this.category = category.name;this.offset = 0;this.renderCategories();this.load(); });
      container.append(button);
    }
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
    $('source-hint').textContent = mode === 'source' ? 'Platinen öffnen · PDFs ansehen · Archive herunterladen' : 'Importierte Platinen mit einem Klick öffnen.';
    this.renderCategories();this.load();
  }

  async refreshIndex() {
    const button = $('source-refresh');button.disabled = true;button.textContent = 'Ordner wird eingelesen …';
    try {
      this.info = await this.request('/source/refresh', { method: 'POST' });
      this.offset = 0;this.renderInfo();await this.load();this.notify('Dateikatalog aktualisiert.');
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
      let result;
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
          category: this.category, sort: $('source-sort').value, offset: String(this.offset), limit: String(this.limit) });
        result = await this.request(`/source/files?${params}`, { signal });
      }
      if (signal.aborted) return;
      this.total = result.total;
      $('source-grid').replaceChildren(...result.items.map(item => this.card(item)));
      $('source-empty').hidden = Boolean(result.items.length);
      $('source-empty-text').textContent = this.mode === 'imports' && !this.getBoards().length
        ? 'Öffne eine Platine aus xzz_downloads oder importiere eine eigene Datei.'
        : 'Versuche einen anderen Modellnamen oder ändere die Filter.';
      $('source-results').textContent = `${count(result.total)} ${result.total === 1 ? 'Datei' : 'Dateien'}${$('source-search').value.trim() ? ` für „${$('source-search').value.trim()}“` : ''}`;
      $('source-page').textContent = result.total ? `${count(this.offset + 1)}–${count(Math.min(this.offset + this.limit, result.total))} von ${count(result.total)}` : 'Keine Ergebnisse';
      $('source-prev').disabled = this.offset === 0;$('source-next').disabled = this.offset + this.limit >= result.total;
    } catch (error) {
      if (error.name !== 'AbortError') this.fail(error);
    } finally {
      if (!signal.aborted) $('source-grid').setAttribute('aria-busy', 'false');
    }
  }

  card(item) {
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
    copy.append(node('span', 'source-card-category', labels[item.category] || item.category),
      node('h2', '', title), node('p', 'source-card-path', item.path.split('/').slice(0, -1).join(' / ') || item.path));
    const identity = [item.brand, item.model, item.board_number].filter(Boolean).join(' · ');
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
    const action = card.querySelector('.source-card-action');action.textContent = 'Lädt …';
    this.notify(`${item.name} wird geöffnet …`, false, true);
    try {
      let id = item.id;
      if (!item.imported) {
        const result = await this.request(`/source/files/${item.id}/open`, { method: 'POST' });
        id = result.board.id;
      }
      await this.openBoard(id);
    } catch (error) { this.notify(`Datei konnte nicht geöffnet werden: ${error.message}`, true); }
    finally { this.opening = false;card.disabled = false;card.classList.remove('opening');action.textContent = 'Öffnen ↗'; }
  }

  fail(error) {
    $('source-grid').replaceChildren();$('source-grid').setAttribute('aria-busy', 'false');
    $('source-results').textContent = 'Katalog konnte nicht geladen werden.';
    $('source-page').textContent = '';
    this.notify(error.message, true);
  }
}
