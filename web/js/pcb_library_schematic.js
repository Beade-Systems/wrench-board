// Schematic dock of the library page: lists the PDFs matched to the active
// board and keeps one PdfPanel in step with the board tabs.
import { PdfPanel } from './pcb_pdf_panel.js';

const $ = id => document.getElementById(id);
const fileUrl = doc => `/api/library/source/files/${encodeURIComponent(doc.id)}/download?inline=true`;

export class SchematicDock {
  constructor({ request, notify, onTerm }) {
    Object.assign(this, { request, notify, onTerm });
    this.panel = null;
    this.boardId = null;
    this.shown = null;
    this.docs = [];
    this.ready = Promise.resolve([]);
    this._documents = new Map();
    this._picked = new Map();
    this._generation = 0;
    $('pdf-select').addEventListener('change', event => {
      const doc = this.docs.find(item => item.id === event.target.value);
      if (doc) this._pick(doc); else this.close();
    });
    $('pdf-close').addEventListener('click', () => this.close());
  }

  /** Shows the documents of `id`; a null id empties the dock. */
  setBoard(id, filename) {
    const generation = ++this._generation;
    this.boardId = id;
    const picked = id ? this._picked.get(id) : null;
    this.docs = [];
    this._fill('Schaltplan wird gesucht …');
    if (picked) this._show(picked); else this._hideDock();
    if (!id) { this._fill('Kein Schaltplan');return; }
    this.ready = this._documentsFor(id, filename).then(docs => {
      if (generation !== this._generation) return docs;
      this.docs = docs;
      this._fill(docs.length ? `Schaltplan wählen (${docs.length})` : 'Kein Schaltplan');
      return docs;
    });
  }

  /** Finds `term` in the board's schematic, opening the best match if none is open. */
  async search(term) {
    const boardId = this.boardId;
    if (!boardId || !term) return;
    let doc = this._picked.get(boardId);
    if (!doc) {
      [doc] = await this.ready;
      if (boardId !== this.boardId) return;
      if (!doc) { this.notify('Für diese Platine ist kein Schaltplan zugeordnet.');return; }
      await this._pick(doc);
    }
    const result = await this.panel.search(term);
    if (result && !result.cancelled && !result.hits) this.notify(`„${term}“ kommt im Schaltplan nicht vor.`);
  }

  close() {
    this._picked.delete(this.boardId);
    if (this.panel?.isPopped) this.panel.dock();
    this._hideDock();
    $('pdf-select').value = '';
  }

  forget(id) {
    this._documents.delete(id);
    this._picked.delete(id);
  }

  dispose() { this.panel?.dispose(); }

  _documentsFor(id, filename) {
    let documents = this._documents.get(id);
    if (!documents) {
      documents = this.request(`/source/documents?filename=${encodeURIComponent(filename)}`)
        .then(data => data.items)
        .catch(() => {
          // No catalog configured or a network error: the board still works.
          this._documents.delete(id);
          return [];
        });
      this._documents.set(id, documents);
    }
    return documents;
  }

  _fill(placeholder) {
    const select = $('pdf-select');
    select.replaceChildren(new Option(placeholder, ''), ...this.docs.map(doc => new Option(doc.name, doc.id)));
    select.disabled = !this.docs.length;
    select.value = this._picked.get(this.boardId)?.id ?? '';
  }

  _pick(doc) {
    this._picked.set(this.boardId, doc);
    $('pdf-select').value = doc.id;
    return this._show(doc);
  }

  _show(doc) {
    this.panel ??= new PdfPanel($('pdf-dock'), {
      onTermClick: token => this.onTerm(token),
      notify: text => this.notify(text),
    });
    $('pdf-dock').hidden = false;
    $('pdf-close').hidden = false;
    if (this.shown?.id === doc.id) return Promise.resolve({ ok: true });
    this.shown = doc;
    return this.panel.open({ url: fileUrl(doc), title: doc.name });
  }

  _hideDock() {
    $('pdf-dock').hidden = true;
    $('pdf-close').hidden = true;
  }
}
