// Lazy folder tree of the source catalog; children load on first expansion.
const COUNT_FIELD = { board: 'boards', pdf: 'pdfs', archive: 'archives', other: 'other' };

function folderCount(folder, kind) {
  const field = COUNT_FIELD[kind];
  return field ? folder[field] : folder.boards + folder.pdfs + folder.archives + folder.other;
}

/** "1.234 Boardviews · 56 PDFs · 3 Ordner", leaving out what the folder lacks. */
export function folderSummary(folder, format) {
  const parts = [[folder.boards, 'Boardviews'], [folder.pdfs, 'PDFs'], [folder.subfolders, 'Ordner']];
  return parts.filter(([value]) => value).map(([value, label]) => `${format(value)} ${label}`).join(' · ');
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class FolderTree {
  /**
   * @param {HTMLElement} container
   * @param {object} options
   * @param {(path: string) => Promise} options.list Resolves to a folder listing.
   * @param {(path: string) => void} options.onSelect
   * @param {() => string} options.kind The file kind the counts refer to.
   * @param {(label: string) => string} options.displayName
   */
  constructor(container, { list, onSelect, kind, displayName }) {
    Object.assign(this, { container, list, onSelect, kind, displayName });
    container.setAttribute('role', 'tree');
    this.reset();
  }

  /** Forgets every node, e.g. because the file-kind filter changed the counts. */
  reset() {
    this._generation = (this._generation ?? 0) + 1;
    this._nodes = new Map();
    this._current = null;
    this._root = { path: '', children: element('ul', 'tree-list'), loaded: null };
    this.container.replaceChildren(this._root.children);
  }

  /** Opens every ancestor of `path` and marks it as the current folder. */
  async reveal(path) {
    const generation = this._generation;
    let node = this._root;
    await this._load(node);
    let prefix = '';
    for (const part of path ? path.split('/') : []) {
      prefix = prefix ? `${prefix}/${part}` : part;
      node = this._nodes.get(prefix);
      if (!node || generation !== this._generation) return;
      await this._open(node);
    }
    if (generation === this._generation) this._markCurrent(path ? node : null);
  }

  _load(node) {
    node.loaded ??= this.list(node.path)
      .then(listing => {
        node.children.replaceChildren(...listing.folders.map(folder => this._createNode(folder)));
        return listing;
      })
      .catch(error => {
        node.loaded = null;
        throw error;
      });
    return node.loaded;
  }

  async _open(node) {
    if (node.expandable === false) return;
    const generation = this._generation;
    let listing;
    try {
      listing = await this._load(node);
    } catch {
      return; // The grid reports the failure; the tree simply stays closed.
    }
    if (generation !== this._generation) return;
    const empty = !listing.folders.length;
    node.toggle.classList.toggle('none', empty);
    node.children.hidden = empty;
    node.item.setAttribute('aria-expanded', String(!empty));
    node.toggle.textContent = empty ? '' : '▾';
  }

  _close(node) {
    node.children.hidden = true;
    node.item.setAttribute('aria-expanded', 'false');
    node.toggle.textContent = '▸';
  }

  _createNode(folder) {
    const item = element('li', 'tree-item');
    item.setAttribute('role', 'treeitem');
    const row = element('div', 'tree-row');
    const expandable = folder.subfolders > 0;
    const toggle = element('button', `tree-toggle${expandable ? '' : ' none'}`, expandable ? '▸' : '');
    toggle.type = 'button';
    toggle.tabIndex = expandable ? 0 : -1;
    toggle.setAttribute('aria-label', `${folder.label} auf- oder zuklappen`);
    const label = element('button', 'tree-label');
    label.type = 'button';
    label.title = folder.name;
    label.append(element('span', 'tree-name', this.displayName(folder.label)), element('small', 'tree-count',
      new Intl.NumberFormat('de-DE').format(folderCount(folder, this.kind()))));
    row.append(toggle, label);
    const children = element('ul', 'tree-list');
    children.setAttribute('role', 'group');
    children.hidden = true;
    item.append(row, children);
    if (expandable) item.setAttribute('aria-expanded', 'false');
    const node = { path: folder.path, item, row, toggle, children, loaded: null, expandable };
    this._nodes.set(folder.path, node);
    toggle.addEventListener('click', () => (children.hidden ? this._open(node) : this._close(node)));
    label.addEventListener('click', () => this.onSelect(folder.path));
    return item;
  }

  _markCurrent(node) {
    this._current?.row.classList.remove('current');
    this._current?.item.removeAttribute('aria-selected');
    this._current = node;
    if (!node) return;
    node.row.classList.add('current');
    node.item.setAttribute('aria-selected', 'true');
    node.row.scrollIntoView({ block: 'nearest' });
  }
}
