import { createRenderScheduler } from './shared/render_scheduler.js';

/** Colour rules for the library viewer: storage, per-board resolution, editor. */

const STORAGE_KEY = 'wrench-board.pcb-library.color-rules.v1';
const HEX = /^#[0-9a-f]{6}$/i;
const COMPONENT_TYPES = ['R', 'C', 'L', 'U', 'Q', 'D', 'J'];
const COMPONENT_LABELS = {
  R: 'Widerstände (R)', C: 'Kondensatoren (C)', L: 'Spulen (L)', U: 'ICs (U)',
  Q: 'Transistoren (Q)', D: 'Dioden (D)', J: 'Steckverbinder (J)',
};
const FILL_ALPHA = '99';

export const DEFAULT_RULES = Object.freeze({
  nets: Object.freeze([
    Object.freeze({ pattern: 'GND', color: '#6f7c86' }),
    Object.freeze({ pattern: 'VCC*', color: '#e0705a' }),
    Object.freeze({ pattern: 'PP*', color: '#d9a441' }),
  ]),
  components: Object.freeze({
    R: '#4d7fa8', C: '#8a6db8', L: '#b0824a', U: '#3f8f73',
    Q: '#b5617f', D: '#a3a04b', J: '#5a8f9e',
  }),
  sides: Object.freeze({ top: '#b6c6a5', bottom: '#82b6c9' }),
});

const validColor = (color, fallback) => (typeof color === 'string' && HEX.test(color) ? color.toLowerCase() : fallback);

/** A complete, private copy of `rules`; anything malformed falls back to the defaults. */
function normalize(rules) {
  const source = rules && typeof rules === 'object' ? rules : {};
  const nets = (Array.isArray(source.nets) ? source.nets : DEFAULT_RULES.nets)
    .filter(rule => typeof rule?.pattern === 'string' && rule.pattern.trim() && HEX.test(rule.color ?? ''))
    .map(rule => ({ pattern: rule.pattern.trim(), color: rule.color.toLowerCase() }));
  const components = {};
  for (const [prefix, color] of Object.entries(source.components ?? DEFAULT_RULES.components)) {
    if (/^[A-Za-z]+$/.test(prefix) && HEX.test(color ?? '')) components[prefix.toUpperCase()] = color.toLowerCase();
  }
  return {
    nets,
    components,
    sides: {
      top: validColor(source.sides?.top, DEFAULT_RULES.sides.top),
      bottom: validColor(source.sides?.bottom, DEFAULT_RULES.sides.bottom),
    },
  };
}

export function loadRules() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return normalize(JSON.parse(stored));
  } catch { /* Storage blocked or corrupt: the defaults still work. */ }
  return normalize(DEFAULT_RULES);
}

export function saveRules(rules) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalize(rules)));
    return true;
  } catch {
    return false;
  }
}

function compilePattern(pattern) {
  const source = pattern.split('*').map(piece => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`, 'i');
}

function netColors(board, nets) {
  const compiled = nets.map(rule => ({ regex: compilePattern(rule.pattern), color: rule.color }));
  const colors = new Map();
  const classify = name => {
    if (!name || colors.has(name)) return;
    colors.set(name, compiled.find(rule => rule.regex.test(name))?.color ?? null);
  };
  for (const net of board.nets || []) classify(net.name);
  for (const pin of board.pins || []) classify(pin.net);
  for (const trace of board.traces || []) classify(trace.net);
  for (const via of board.vias || []) classify(via.net);
  for (const pad of board.test_pads || []) classify(pad.net);
  return colors;
}

const prefixOf = refdes => (/^[A-Za-z]+/.exec(refdes || '')?.[0] || '').toUpperCase();

/**
 * Per-entity colours, in arrays parallel to the board's own, so the paint loop
 * does an index read per entity. Entries are null where a net has no rule.
 */
export function resolve(board, rules) {
  const { nets: netRules, components, sides } = normalize(rules);
  const nets = netColors(board, netRules);
  const sideColor = layer => (layer === 2 ? sides.bottom : sides.top);
  const netColor = name => (name ? nets.get(name) ?? null : null);
  const parts = board.parts || [];
  const partFill = new Array(parts.length);
  const partStroke = new Array(parts.length);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const side = sideColor(part.layer);
    partFill[index] = (components[prefixOf(part.refdes)] ?? side) + FILL_ALPHA;
    partStroke[index] = side;
  }
  return {
    nets,
    partFill,
    partStroke,
    pinFill: (board.pins || []).map(pin => netColor(pin.net) ?? sideColor(pin.layer)),
    traceStroke: (board.traces || []).map(trace => netColor(trace.net)),
    viaStroke: (board.vias || []).map(via => netColor(via.net)),
    testPadStroke: (board.test_pads || []).map(pad => netColor(pad.net)),
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, onClick) {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

/**
 * Colour rule form. Edits are previewed live; Apply stores them in localStorage
 * and reports them. Discard returns to the last applied rules.
 */
export class ColorRulesEditor {
  constructor(container, { onPreview, onApply } = {}) {
    this.container = container;
    this.onPreview = onPreview;
    this.onApply = onApply;
    this._applied = loadRules();
    this._draft = normalize(this._applied);
    this._preview = createRenderScheduler(() => this.onPreview?.(this.rules()));
    this.render();
  }

  /** The current draft, including edits that were not applied yet. */
  rules() { return normalize(this._draft); }

  setRules(rules) {
    this._applied = normalize(rules);
    this._draft = normalize(rules);
    this.render();
  }

  dispose() {
    this._preview.dispose();
    this.container.replaceChildren();
  }

  _colorInput(label, value, onChange) {
    const input = element('input', 'cr-color');
    input.type = 'color';
    input.value = value;
    input.setAttribute('aria-label', `Farbe für ${label}`);
    input.addEventListener('input', () => { onChange(input.value); this._preview.request(); });
    return input;
  }

  _colorRow(label, value, onChange) {
    const row = element('label', 'cr-row');
    row.append(element('span', 'cr-label', label), this._colorInput(label, value, onChange));
    return row;
  }

  _netRow(rule) {
    const row = element('div', 'cr-row');
    const pattern = element('input', 'cr-pattern');
    pattern.type = 'text';
    pattern.value = rule.pattern;
    pattern.placeholder = 'Muster, z. B. PP*';
    pattern.spellcheck = false;
    pattern.setAttribute('aria-label', 'Netzmuster');
    pattern.addEventListener('input', () => { rule.pattern = pattern.value; this._preview.request(); });
    const remove = button('cr-remove', '×', () => {
      this._draft.nets.splice(this._draft.nets.indexOf(rule), 1);
      this.render();
      this._preview.request();
    });
    remove.setAttribute('aria-label', `Regel ${rule.pattern || 'ohne Muster'} entfernen`);
    row.append(pattern, this._colorInput(rule.pattern || 'neue Regel', rule.color, color => { rule.color = color; }), remove);
    return row;
  }

  _section(title, rows, hint) {
    const section = element('section', 'cr-section');
    section.append(element('h4', 'cr-heading', title));
    if (hint) section.append(element('p', 'cr-hint', hint));
    section.append(...rows);
    return section;
  }

  render() {
    const draft = this._draft;
    const add = button('text-button cr-add', 'Regel hinzufügen', () => {
      draft.nets.push({ pattern: '', color: '#a8e6bd' });
      this.render();
      this.container.querySelector('.cr-section .cr-row:last-of-type .cr-pattern')?.focus();
    });
    const nets = this._section('Netze', [...draft.nets.map(rule => this._netRow(rule)), add],
      'Die erste passende Regel gilt. * steht für beliebige Zeichen.');
    const components = this._section('Bauteiltypen', COMPONENT_TYPES.map(prefix => this._colorRow(
      COMPONENT_LABELS[prefix], draft.components[prefix] ?? DEFAULT_RULES.components[prefix],
      color => { draft.components[prefix] = color; })));
    const sides = this._section('Platinenseiten', [
      this._colorRow('Oberseite', draft.sides.top, color => { draft.sides.top = color; }),
      this._colorRow('Unterseite', draft.sides.bottom, color => { draft.sides.bottom = color; }),
    ]);
    const actions = element('div', 'cr-actions');
    actions.append(
      button('primary', 'Anwenden', () => {
        this._applied = this.rules();
        saveRules(this._applied);
        this.onApply?.(this.rules());
      }),
      button('secondary', 'Verwerfen', () => {
        this._draft = normalize(this._applied);
        this.render();
        this._preview.request();
      }),
      button('secondary', 'Standardfarben', () => {
        this._draft = normalize(DEFAULT_RULES);
        this.render();
        this._preview.request();
      }),
    );
    this.container.replaceChildren(nets, components, sides, actions);
  }
}
