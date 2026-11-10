import { createRenderScheduler } from './shared/render_scheduler.js';
import { resolve as resolveColors } from './pcb_color_rules.js';

const LAYOUTS = new Set(['single', 'butterfly']);
const RECT_PADS = new Set(['rect', 'square', 'roundrect']);
const TAU = Math.PI * 2;
const OUTLINE_LAYER = 28;
// Older imports can hold mis-decoded arcs hundreds of metres wide; see board_mapper.py.
const MAX_ARC_EXTENT = 100000;
const usableArc = arc => arc.radius > 0 && arc.radius <= MAX_ARC_EXTENT
  && Math.abs(arc.center.x) <= MAX_ARC_EXTENT && Math.abs(arc.center.y) <= MAX_ARC_EXTENT;
const COLOR = {
  outline: '#79a98a', board: '#17302688', trace: '#33554a', net: '#f7cf7a', pinNet: '#f7d48a',
  neighbour: '#d8c79f', compare: '#ff6ad5', compareFill: '#ff6ad566', pad: '#6a9f9a', spine: '#3a4a52',
};

/** Neighbouring nets fade with distance but stay visible over a dimmed board. */
const neighbourAlpha = depth => (depth <= 1 ? .85 : depth === 2 ? .65 : .5);

// Dependency-free canvas view of the normalized Board model (coordinates: mils).
export class LibraryViewer {
  constructor(canvas, onSelect, onPosition) {
    this.canvas = canvas;
    this._events = new AbortController();
    this._scheduler = createRenderScheduler(() => this.paint());
    const listen = (type, callback, options = {}) => canvas.addEventListener(
      type, callback, { ...options, signal: this._events.signal }
    );
    const local = event => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    this.ctx = canvas.getContext('2d');
    this.onSelect = onSelect;
    this.onPosition = onPosition;
    this.side = 3;
    this.labels = true;
    this.mirror = false;
    this.traceLayer = '';
    this.scale = 1;
    this.center = { x: 0, y: 0 };
    this.selected = null;
    this.net = null;
    this._layout = 'single';
    this._pointers = new Map();
    this._gesture = null;
    this._rules = null;
    this._colors = null;
    this._highlightedPins = null;
    this._extraNets = null;
    canvas.style.touchAction = 'none';
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(canvas.parentElement);
    listen('wheel', event => {
      if (!this.board) return;
      event.preventDefault();
      this.zoom(Math.exp(-Math.max(-200, Math.min(200, event.deltaY)) * .005), local(event));
    }, { passive: false });
    listen('pointerdown', event => {
      if (event.button !== 0 || !this.board) return;
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      const point = local(event);
      this._pointers.set(event.pointerId, point);
      if (this._pointers.size >= 2) {
        this.drag = null;
        this._startGesture();
      } else {
        this._startDrag(event.pointerId, point, false);
      }
    });
    listen('pointermove', event => {
      const point = local(event);
      if (this.board) this.onPosition?.(this.world(point));
      if (this._pointers.has(event.pointerId)) this._pointers.set(event.pointerId, point);
      if (this._gesture) {
        if (this._pointers.has(event.pointerId)) this._updateGesture();
        return;
      }
      if (!this.drag || event.pointerId !== this.drag.id) return;
      const dx = point.x - this.drag.x, dy = point.y - this.drag.y;
      if (Math.hypot(dx, dy) > 4) this.drag.moved = true;
      this.center = { x: this.drag.center.x - dx / this.scale * (this.drag.pane.mirror ? -1 : 1),
        y: this.drag.center.y + dy / this.scale };
      this.draw();
    });
    listen('pointerup', event => {
      const inGesture = Boolean(this._gesture);
      this._pointers.delete(event.pointerId);
      if (inGesture) { this._continueAfterGesture(); return; }
      if (!this.drag || event.pointerId !== this.drag.id) return;
      if (!this.drag.moved) this.pick(this.world(local(event)));
      this.drag = null;
    });
    listen('pointercancel', event => {
      this._pointers.delete(event.pointerId);
      this.drag = null;
      this._gesture = null;
    });
    listen('lostpointercapture', event => {
      this._pointers.delete(event.pointerId);
      if (this.drag?.id === event.pointerId) this.drag = null;
      if (this._pointers.size < 2) this._gesture = null;
    });
    listen('keydown', event => {
      if (!this.board) return;
      if (['+', '=', '-', '0', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.preventDefault();
      if (event.key === '+' || event.key === '=') this.zoom(1.3);
      if (event.key === '-') this.zoom(1 / 1.3);
      if (event.key === '0') this.fit();
      if (event.key === 'Escape') this.select(null);
      const step = 40 / this.scale;
      if (event.key === 'ArrowLeft') this.center.x -= step * (this.mirror ? -1 : 1);
      if (event.key === 'ArrowRight') this.center.x += step * (this.mirror ? -1 : 1);
      if (event.key === 'ArrowUp') this.center.y += step;
      if (event.key === 'ArrowDown') this.center.y -= step;
      this.draw();
    });
    this.resize();
  }

  resize() {
    const { width, height } = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.ratio);
    this.canvas.height = Math.round(this.height * this.ratio);
    this.draw();
  }

  load(board) {
    this.board = board;
    this.selected = null;
    this.net = null;
    this._highlightedPins = null;
    this._extraNets = null;
    this._colors = board && this._rules ? resolveColors(board, this._rules) : null;
    if (!board) { this.draw(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const include = point => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
    };
    board.outline.forEach(include);
    board.pins.forEach(pin => include(pin.pos));
    board.parts.forEach(part => part.bbox.forEach(include));
    (board.arcs || []).filter(arc => usableArc(arc) && arc.layer === OUTLINE_LAYER).forEach(arc => {
      include({ x: arc.center.x - arc.radius, y: arc.center.y - arc.radius });
      include({ x: arc.center.x + arc.radius, y: arc.center.y + arc.radius });
    });
    // Outline, pins and parts define the board's edge. Some files decode stray
    // traces or pads far outside it, so those only count when nothing else exists.
    if (!Number.isFinite(minX)) {
      (board.traces || []).forEach(trace => { include(trace.a); include(trace.b); });
      (board.vias || []).forEach(via => include(via.pos));
      (board.test_pads || []).forEach(pad => include(pad.pos));
    }
    this.bounds = Number.isFinite(minX) ? { minX, minY, maxX, maxY }
      : { minX: 0, minY: 0, maxX: 1000, maxY: 600 };
    this.fit();
  }

  get layout() { return this._layout; }

  /** Keeps the zoom relative to fit, so a fitted board stays fitted in the new panes. */
  set layout(layout) {
    if (!LAYOUTS.has(layout) || layout === this._layout) return;
    const zoomed = this.baseScale ? this.scale / this.baseScale : 1;
    this._layout = layout;
    if (this.board) {
      this.baseScale = this._fitScale();
      this.scale = this.baseScale * zoomed;
    }
    this.draw();
  }

  get _butterfly() { return this._layout === 'butterfly'; }

  /** Pane 0 is the whole canvas or, in butterfly, the top side; pane 1 the bottom side. */
  _pane(index) {
    if (!this._butterfly) return { left: 0, width: this.width, side: this.side, mirror: this.mirror };
    return { left: index ? this.width / 2 : 0, width: this.width / 2,
      side: index ? 2 : 1, mirror: index ? !this.mirror : this.mirror };
  }

  _paneAt(x) { return this._pane(this._butterfly && x >= this.width / 2 ? 1 : 0); }

  _fitScale() {
    const b = this.bounds;
    return Math.min(this._pane(0).width / Math.max(100, b.maxX - b.minX),
      this.height / Math.max(100, b.maxY - b.minY)) * .82;
  }

  _clampScale(scale) {
    return Math.max(this.baseScale / 20, Math.min(this.baseScale * 500, scale));
  }

  fit() {
    if (!this.board) return;
    const b = this.bounds;
    this.center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    this.scale = this._fitScale();
    this.baseScale = this.scale;
    this.draw();
  }

  /** Canvas point to board point. In butterfly the result names its pane's `side`. */
  world(point) {
    const pane = this._paneAt(point.x);
    const result = this._unproject(pane, point);
    if (this._butterfly) result.side = pane.side;
    return result;
  }

  /** Board point to canvas point; in butterfly `side` 2 selects the bottom pane. */
  screen(point, side = point.side) {
    const pane = this._pane(this._butterfly && side === 2 ? 1 : 0);
    return { x: pane.left + pane.width / 2 + (point.x - this.center.x) * this.scale * (pane.mirror ? -1 : 1),
      y: this.height / 2 - (point.y - this.center.y) * this.scale };
  }

  _unproject(pane, point) {
    return { x: this.center.x + (point.x - pane.left - pane.width / 2) / this.scale * (pane.mirror ? -1 : 1),
      y: this.center.y - (point.y - this.height / 2) / this.scale };
  }

  zoom(factor, anchor = { x: this._pane(0).left + this._pane(0).width / 2, y: this.height / 2 }) {
    if (!this.board) return;
    const before = this.world(anchor);
    this.scale = this._clampScale(this.scale * factor);
    const after = this.world(anchor);
    this.center.x += before.x - after.x;
    this.center.y += before.y - after.y;
    this.draw();
  }

  _startDrag(id, point, moved) {
    this.drag = { id, x: point.x, y: point.y, center: { ...this.center },
      pane: this._paneAt(point.x), moved };
  }

  _gesturePoints() {
    const [a, b] = this._pointers.values();
    return { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  _startGesture() {
    const { distance, middle } = this._gesturePoints();
    const pane = this._paneAt(middle.x);
    this._gesture = { distance, scale: this.scale, pane, anchor: this._unproject(pane, middle) };
  }

  /** The board point that was under the fingers stays under their midpoint. */
  _updateGesture() {
    const { distance, middle } = this._gesturePoints();
    const { pane, anchor } = this._gesture;
    this.scale = this._clampScale(this._gesture.scale * distance / this._gesture.distance);
    this.center = {
      x: anchor.x - (middle.x - pane.left - pane.width / 2) / this.scale * (pane.mirror ? -1 : 1),
      y: anchor.y + (middle.y - this.height / 2) / this.scale,
    };
    this.draw();
  }

  /** A finger lifted mid-gesture: remaining fingers keep panning but never tap. */
  _continueAfterGesture() {
    if (this._pointers.size >= 2) { this._startGesture(); return; }
    this._gesture = null;
    const [remaining] = this._pointers;
    if (remaining) this._startDrag(remaining[0], remaining[1], true);
  }

  getView() {
    return { center: { ...this.center }, scale: this.scale, baseScale: this.baseScale, side: this.side,
      mirror: this.mirror, traceLayer: this.traceLayer, labels: this.labels, layout: this._layout };
  }

  setView(view) {
    if (!view) return;
    if (Number.isFinite(view.center?.x) && Number.isFinite(view.center?.y)) this.center = { x: view.center.x, y: view.center.y };
    if (view.scale > 0) this.scale = view.scale;
    if (view.baseScale > 0) this.baseScale = view.baseScale;
    if ([1, 2, 3].includes(view.side)) this.side = view.side;
    this.mirror = Boolean(view.mirror);
    this.traceLayer = typeof view.traceLayer === 'string' ? view.traceLayer : '';
    this.labels = view.labels !== false;
    if (LAYOUTS.has(view.layout)) this._layout = view.layout;
    this.draw();
  }

  /** Extra emphasis for indexes into `board.pins`; null clears it. */
  setHighlightedPins(pins) {
    this._highlightedPins = pins?.size ? new Set(pins) : null;
    this.draw();
  }

  /** Lighter highlight for neighbouring nets (net name to hop count); null clears it. */
  setExtraNets(nets) {
    this._extraNets = nets?.size ? new Map(nets) : null;
    this.draw();
  }

  /** Rules as defined by pcb_color_rules.js; null restores the built-in colours. */
  setColorRules(rules) {
    this._rules = rules ?? null;
    this._colors = this.board && this._rules ? resolveColors(this.board, this._rules) : null;
    this.draw();
  }

  visible(layer) { return Boolean(layer & (this._butterfly ? 3 : this.side)); }

  select(selection, focus = false) {
    this.selected = selection;
    this.net = selection?.kind === 'net' ? selection.item.name
      : selection?.kind === 'pin' ? selection.item.net : null;
    if (focus && selection?.kind === 'part') {
      const [a, b] = selection.item.bbox;
      this.center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.scale = Math.min(this.baseScale * 70, Math.max(this.scale,
        Math.min(this._pane(0).width / Math.max(50, b.x - a.x), this.height / Math.max(50, b.y - a.y)) * .35));
    }
    this.onSelect?.(selection);
    this.draw();
  }

  pick(point) {
    const threshold = 8 / this.scale;
    const shown = layer => (this._butterfly && point.side ? Boolean(layer & point.side) : this.visible(layer));
    let nearest = null, distance = threshold;
    for (const pin of this.board.pins) {
      if (!shown(pin.layer)) continue;
      const d = Math.hypot(pin.pos.x - point.x, pin.pos.y - point.y);
      const radius = pin.pad_size ? Math.max(...pin.pad_size) / 2 : 0;
      if (d < Math.max(threshold, radius) && (!nearest || d < distance)) { nearest = pin; distance = d; }
    }
    if (nearest) { this.select({ kind: 'pin', item: nearest }); return; }
    const parts = this.board.parts.filter(part => {
      const [a, b] = part.bbox;
      return shown(part.layer) && point.x >= a.x - threshold / 3 && point.x <= b.x + threshold / 3
        && point.y >= a.y - threshold / 3 && point.y <= b.y + threshold / 3;
    });
    parts.sort((a, b) => (a.bbox[1].x - a.bbox[0].x) * (a.bbox[1].y - a.bbox[0].y)
      - (b.bbox[1].x - b.bbox[0].x) * (b.bbox[1].y - b.bbox[0].y));
    this.select(parts.length ? { kind: 'part', item: parts[0] } : null);
  }

  draw() {
    this._scheduler.request();
  }

  dispose() {
    this._events.abort();
    this._resizeObserver.disconnect();
    this._scheduler.dispose();
    this.drag = null;
    this._gesture = null;
    this._pointers.clear();
    this.board = null;
    this.selected = null;
    this._colors = null;
    this._highlightedPins = null;
    this._extraNets = null;
  }

  paint() {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.board) return;
    if (this._butterfly) {
      for (const index of [0, 1]) {
        const pane = this._pane(index);
        ctx.save();
        ctx.beginPath();ctx.rect(pane.left, 0, pane.width, this.height);ctx.clip();
        this._paintPane(pane);
        ctx.restore();
      }
      this._paintButterflyChrome();
    } else {
      this._paintPane(this._pane(0));
    }
    this._paintScaleBar();
  }

  _paintPane(pane) {
    const ctx = this.ctx;
    const margin = 20 / this.scale;
    const halfWidth = pane.width / 2 / this.scale + margin;
    const halfHeight = this.height / 2 / this.scale + margin;
    const view = { pane, minX: this.center.x - halfWidth, maxX: this.center.x + halfWidth,
      minY: this.center.y - halfHeight, maxY: this.center.y + halfHeight,
      selectedRef: this.selected?.kind === 'part' ? this.selected.item.refdes
        : this.selected?.kind === 'pin' ? this.selected.item.part_refdes : null };
    ctx.save();
    ctx.translate(pane.left + pane.width / 2, this.height / 2);
    ctx.scale(this.scale * (pane.mirror ? -1 : 1), -this.scale);
    ctx.translate(-this.center.x, -this.center.y);
    ctx.lineWidth = 1 / this.scale;
    this._paintOutline();
    this._paintTraces(view);
    this._paintArcs();
    this._paintParts(view);
    this._paintPins(view);
    this._paintPads(view, this.board.vias || [], this._colors?.viaStroke);
    this._paintPads(view, this.board.test_pads || [], this._colors?.testPadStroke);
    this._paintComparedPins(view);
    ctx.restore();
    if (this.labels) this._paintLabels(view);
  }

  _inView(view, ax, ay, bx = ax, by = ay) {
    return Math.max(ax, bx) >= view.minX && Math.min(ax, bx) <= view.maxX
      && Math.max(ay, by) >= view.minY && Math.min(ay, by) <= view.maxY;
  }

  _segment(a, b) {
    const ctx = this.ctx;
    ctx.beginPath();ctx.moveTo(a.x, a.y);ctx.lineTo(b.x, b.y);ctx.stroke();
  }

  _paintOutline() {
    const { ctx, board } = this;
    if (board.outline.length <= 1) return;
    ctx.beginPath();
    board.outline.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
    ctx.closePath();ctx.fillStyle = COLOR.board;ctx.fill();ctx.strokeStyle = COLOR.outline;ctx.stroke();
  }

  _paintTraces(view) {
    const { ctx, net } = this;
    const traces = this.board.traces || [];
    const all = this.traceLayer === 'all';
    const wanted = this.traceLayer === '' ? NaN : Number(this.traceLayer);
    const colors = this._colors?.traceStroke;
    const extra = this._extraNets;
    for (let index = 0; index < traces.length; index++) {
      const trace = traces[index];
      if (trace.layer !== OUTLINE_LAYER && !all && trace.layer !== wanted) continue;
      if (!this._inView(view, trace.a.x, trace.a.y, trace.b.x, trace.b.y)) continue;
      ctx.strokeStyle = trace.layer === OUTLINE_LAYER ? COLOR.outline
        : net && trace.net === net ? COLOR.net
        : extra?.has(trace.net) ? COLOR.neighbour
        : colors?.[index] ?? COLOR.trace;
      ctx.lineWidth = Math.max(1 / this.scale, trace.width || 0);
      this._segment(trace.a, trace.b);
    }
    ctx.lineWidth = 1 / this.scale;
  }

  _paintArcs() {
    const ctx = this.ctx;
    for (const arc of this.board.arcs || []) {
      if (!usableArc(arc) || (arc.layer !== OUTLINE_LAYER && this.traceLayer !== 'all' && String(arc.layer) !== this.traceLayer)) continue;
      ctx.strokeStyle = arc.layer === OUTLINE_LAYER ? COLOR.outline : COLOR.trace;
      ctx.beginPath();ctx.arc(arc.center.x, arc.center.y, arc.radius,
        arc.angle_start * Math.PI / 180, arc.angle_end * Math.PI / 180);ctx.stroke();
    }
  }

  _paintParts(view) {
    const { ctx, board, scale, net } = this;
    const fills = this._colors?.partFill;
    const strokes = this._colors?.partStroke;
    const side = view.pane.side;
    for (let index = 0; index < board.parts.length; index++) {
      const part = board.parts[index];
      if (!(part.layer & side)) continue;
      const [a, b] = part.bbox;
      if (!this._inView(view, a.x, a.y, b.x, b.y)) continue;
      const chosen = part.refdes === view.selectedRef;
      ctx.globalAlpha = net && !chosen ? .45 : 1;
      ctx.fillStyle = chosen ? '#538b5a99' : fills?.[index] ?? (part.layer === 2 ? '#25414d99' : '#27473999');
      ctx.strokeStyle = chosen ? '#c6f8a1' : strokes?.[index] ?? (part.layer === 2 ? '#6a9eb0' : '#6b9e7b');
      if (part.placement_inferred) ctx.strokeStyle = '#e9b45e';
      ctx.setLineDash(part.placement_inferred ? [4 / scale, 3 / scale] : []);
      ctx.lineWidth = (chosen ? 2 : .8) / scale;
      ctx.fillRect(a.x, a.y, Math.max(b.x - a.x, 1 / scale), Math.max(b.y - a.y, 1 / scale));
      if (part.body_lines?.length) part.body_lines.forEach(line => this._segment(line.a, line.b));
      else ctx.strokeRect(a.x, a.y, Math.max(b.x - a.x, 1 / scale), Math.max(b.y - a.y, 1 / scale));
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  _paintPins(view) {
    const { ctx, board, scale, net } = this;
    const fills = this._colors?.pinFill;
    const extra = this._extraNets;
    const side = view.pane.side;
    const minimum = 1.5 / scale;
    for (let index = 0; index < board.pins.length; index++) {
      const pin = board.pins[index];
      if (!(pin.layer & side) || !this._inView(view, pin.pos.x, pin.pos.y)) continue;
      const chosen = net ? pin.net === net : pin.part_refdes === view.selectedRef;
      const depth = extra?.get(pin.net);
      const neighbour = depth !== undefined && !chosen;
      ctx.globalAlpha = neighbour ? neighbourAlpha(depth) : net && !chosen ? .2 : 1;
      ctx.fillStyle = chosen ? COLOR.pinNet : neighbour ? COLOR.neighbour
        : fills?.[index] ?? (pin.layer === 2 ? '#82b6c9' : '#b6c6a5');
      const [width, height] = pin.pad_size || [5, 5];
      const w = Math.max(width, minimum), h = Math.max(height, minimum);
      const rotation = (pin.pad_rotation_deg || 0) * Math.PI / 180;
      if (!RECT_PADS.has(pin.pad_shape)) {
        ctx.beginPath();ctx.ellipse(pin.pos.x, pin.pos.y, w / 2, h / 2, rotation, 0, TAU);ctx.fill();
      } else if (rotation) {
        ctx.save();ctx.translate(pin.pos.x, pin.pos.y);ctx.rotate(rotation);
        ctx.fillRect(-w / 2, -h / 2, w, h);ctx.restore();
      } else {
        ctx.fillRect(pin.pos.x - w / 2, pin.pos.y - h / 2, w, h);
      }
    }
    ctx.globalAlpha = 1;
  }

  _paintPads(view, pads, colors) {
    const { ctx, net, scale } = this;
    const extra = this._extraNets;
    const side = view.pane.side;
    ctx.lineWidth = 1 / scale;
    for (let index = 0; index < pads.length; index++) {
      const pad = pads[index];
      if ((pad.layer && !(pad.layer & side)) || !this._inView(view, pad.pos.x, pad.pos.y)) continue;
      ctx.strokeStyle = net && pad.net === net ? COLOR.pinNet
        : extra?.has(pad.net) ? COLOR.neighbour
        : colors?.[index] ?? COLOR.pad;
      ctx.beginPath();ctx.arc(pad.pos.x, pad.pos.y, Math.max(pad.radius, 1 / scale), 0, TAU);ctx.stroke();
    }
  }

  /** Drawn last and at a fixed screen size, so compared pins survive zooming out. */
  _paintComparedPins(view) {
    const pins = this._highlightedPins;
    if (!pins) return;
    const { ctx, scale, board } = this;
    const side = view.pane.side;
    const radius = 6 / scale;
    ctx.fillStyle = COLOR.compareFill;ctx.strokeStyle = COLOR.compare;ctx.lineWidth = 2 / scale;
    for (const index of pins) {
      const pin = board.pins[index];
      if (!pin || !(pin.layer & side) || !this._inView(view, pin.pos.x, pin.pos.y)) continue;
      const pad = pin.pad_size ? Math.max(...pin.pad_size) / 2 : 0;
      ctx.beginPath();ctx.arc(pin.pos.x, pin.pos.y, Math.max(radius, pad + 2 / scale), 0, TAU);ctx.fill();ctx.stroke();
    }
  }

  _paintLabels(view) {
    const { ctx, scale } = this;
    const { pane, selectedRef } = view;
    const originX = pane.left + pane.width / 2;
    const sign = pane.mirror ? -1 : 1;
    ctx.font = '10px "IBM Plex Mono", monospace';ctx.textAlign = 'center';ctx.textBaseline = 'middle';
    let count = 0;
    for (const part of this.board.parts) {
      if (!(part.layer & pane.side)) continue;
      const [a, b] = part.bbox;
      if (!this._inView(view, a.x, a.y, b.x, b.y)) continue;
      if (part.refdes !== selectedRef && Math.abs(b.x - a.x) * scale < part.refdes.length * 6) continue;
      if (++count > 3000) break;
      const x = originX + ((a.x + b.x) / 2 - this.center.x) * scale * sign;
      const y = this.height / 2 - ((a.y + b.y) / 2 - this.center.y) * scale;
      ctx.lineWidth = 3;ctx.strokeStyle = '#102018';ctx.strokeText(part.refdes, x, y);
      ctx.fillStyle = part.refdes === selectedRef ? '#e4ffc9' : '#c4d8ca';ctx.fillText(part.refdes, x, y);
    }
  }

  _paintButterflyChrome() {
    const ctx = this.ctx;
    ctx.strokeStyle = COLOR.spine;ctx.lineWidth = 1;
    ctx.beginPath();ctx.moveTo(this.width / 2, 0);ctx.lineTo(this.width / 2, this.height);ctx.stroke();
    ctx.font = '10px "IBM Plex Mono", monospace';ctx.textAlign = 'left';ctx.textBaseline = 'top';ctx.fillStyle = '#94a79f';
    for (const index of [0, 1]) {
      const pane = this._pane(index);
      ctx.fillText(`${index ? 'Unterseite' : 'Oberseite'}${pane.mirror ? ' · gespiegelt' : ''}`, pane.left + 12, 10);
    }
  }

  _paintScaleBar() {
    const ctx = this.ctx;
    const scaleMils = 100 / this.scale;
    const mm = scaleMils * .0254;
    const magnitude = Math.pow(10, Math.floor(Math.log10(mm)));
    const niceMM = Math.max(.000001, Math.floor(mm / magnitude) * magnitude);
    const length = niceMM / .0254 * this.scale;
    ctx.strokeStyle = '#839a90';ctx.lineWidth = 1;
    ctx.beginPath();ctx.moveTo(this.width - length - 20, this.height - 25);ctx.lineTo(this.width - 20, this.height - 25);ctx.stroke();
    ctx.fillStyle = '#94a79f';ctx.font = '10px monospace';ctx.textAlign = 'right';ctx.textBaseline = 'middle';
    ctx.fillText(`${Number(niceMM.toPrecision(3))} mm`, this.width - 20, this.height - 34);
  }
}
