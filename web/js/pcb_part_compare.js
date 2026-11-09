// Pure pin-by-pin comparison of one part across two boards. No DOM, no I/O:
// everything reported comes straight from the Board JSON (api/board/model.py).

/** Minimum Jaccard similarity of two nets' endpoints to call them the same net. */
export const RENAME_JACCARD_THRESHOLD = 0.6;

export const STATUSES = Object.freeze([
  'same', 'renamed', 'equivalent_rail', 'unused', 'different', 'missing',
]);

/** Statuses that are real differences; the others are equal or harmless. */
export const DIFFERING_STATUSES = Object.freeze(['different', 'missing']);

const NC_NAME = /^(?:nc|n\/c|n\.c\.?|dnc|nc[_-]?\d+|no[_ -]?connect(?:ion)?|no[_ -]?net|none|unconnected(?:[-_ ].*)?|net-\(.*)$/i;
// Sequential export numbering (XZZ "Net1000") is assigned per file, so equal
// numbers across two boards prove nothing. Schematic-derived IDs such as
// "N193761300" are stable and stay ordinary names.
const AUTO_NUMBERED_NAME = /^net[_-]?\d+$/i;
const GROUND_NAME = /^(?:GND|GROUND|VSS|0V|AGND|DGND|PGND|SGND|CGND|EGND|GNDA|GNDD|GNDP|VSSA|VSSD)$/;
// A "-" right after the prefix would be a negative rail, so only "_" may join.
const RAIL_NAME = /^\+?(?:(PP|VCC|VDD|V|P)_?)?\+?(\d{1,3})(?:([VP.])(\d{1,3}))?(V?)(?:[_-]*([A-Z][A-Z0-9_-]*))?$/;

const foldName = name => name.trim().toUpperCase();

/** True when a net name means "nothing is connected here". */
export function isUnusedNetName(name) {
  const trimmed = (name ?? '').trim();
  return trimmed === '' || NC_NAME.test(trimmed);
}

/** Canonical "<millivolts>|<domain>" for a rail name, or null if it is not one. */
export function railIdentity(name) {
  const match = RAIL_NAME.exec(foldName(name ?? ''));
  if (!match) return null;
  const [, prefix = '', whole, separator, fraction, trailingV, domain = ''] = match;
  if (!separator && !trailingV) return null;
  // "P1.2" is an MCU port and a bare "1P8" is ambiguous; both need a V to count.
  if (separator === '.' && !trailingV) return null;
  if (separator === 'P' && !trailingV && !['PP', 'VCC', 'VDD', 'V'].includes(prefix)) return null;
  const volts = Number(`${whole}.${fraction || 0}`);
  return `${Math.round(volts * 1000)}|${domain.replace(/[_-]/g, '')}`;
}

function pinLabel(pin) {
  const name = pin.name == null ? '' : String(pin.name).trim();
  return name || String(pin.index);
}

// "a01" and "A1" are the same ball; "1" and "01" the same pad.
const pinKey = pin => pinLabel(pin).toUpperCase().replace(/^([A-Z]*)0+(?=\d)/, '$1');

const indexes = new WeakMap();

function boardIndex(board) {
  let index = indexes.get(board);
  if (index) return index;
  const partPins = new Map(), netPins = new Map();
  board.pins.forEach((pin, pinRef) => {
    let refs = partPins.get(pin.part_refdes);
    if (!refs) partPins.set(pin.part_refdes, refs = []);
    refs.push(pinRef);
    if (!pin.net) return;
    let members = netPins.get(pin.net);
    if (!members) netPins.set(pin.net, members = []);
    members.push(pinRef);
  });
  index = {
    board, partPins, netPins,
    nets: new Map(board.nets.map(net => [net.name, net])),
    parts: new Map(board.parts.map(part => [part.refdes, part])),
    endpointSets: new Map(),
  };
  indexes.set(board, index);
  return index;
}

function endpointKey(pin) { return `${pin.part_refdes.toUpperCase()}.${pinKey(pin)}`; }

function endpoints(index, netName) {
  let set = index.endpointSets.get(netName);
  if (!set) {
    set = new Set((index.netPins.get(netName) || []).map(ref => endpointKey(index.board.pins[ref])));
    index.endpointSets.set(netName, set);
  }
  return set;
}

function intersectionSize(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let count = 0;
  for (const item of small) if (large.has(item)) count += 1;
  return count;
}

// The compared pins are on their nets by construction, so they are left out:
// otherwise any net would look similar to itself just by touching this pin.
function connectivity(run, pinA, pinB) {
  const setA = endpoints(run.a, pinA.net), setB = endpoints(run.b, pinB.net);
  const memoKey = `${pinA.net}\0${pinB.net}`;
  let raw = run.intersections.get(memoKey);
  if (raw === undefined) run.intersections.set(memoKey, raw = intersectionSize(setA, setB));
  const selfA = endpointKey(pinA), selfB = endpointKey(pinB);
  let shared = raw;
  if (setB.has(selfA)) shared -= 1;
  if (selfA !== selfB && setA.has(selfB)) shared -= 1;
  const onlyA = setA.size - 1 - shared, onlyB = setB.size - 1 - shared;
  const union = shared + onlyA + onlyB;
  return { shared, onlyA, onlyB, jaccard: union ? shared / union : null };
}

function pinSide(index, pinRef) {
  const pin = index.board.pins[pinRef];
  const side = {
    pinRef, part_refdes: pin.part_refdes, label: pinLabel(pin), name: pin.name ?? null,
    index: pin.index, net: pin.net || null, pos: pin.pos, layer: pin.layer,
    connections: pin.net ? (index.netPins.get(pin.net)?.length ?? 1) - 1 : 0,
  };
  if (pin.probe != null) side.probe = pin.probe;
  const net = pin.net ? index.nets.get(pin.net) : null;
  if (net) {
    side.is_power = net.is_power;
    side.is_ground = net.is_ground;
    if (net.expected_voltage_v != null) side.expected_voltage_v = net.expected_voltage_v;
    if (net.expected_resistance_ohms != null) side.expected_resistance_ohms = net.expected_resistance_ohms;
    // The model defaults this to false, which means "no expectation", not "not open".
    if (net.expected_open) side.expected_open = true;
  }
  return side;
}

function classify(run, pinA, pinB, sideA, sideB) {
  const nameA = pinA.net ?? '', nameB = pinB.net ?? '';
  const unusedA = isUnusedNetName(nameA), unusedB = isUnusedNetName(nameB);
  if (unusedA || unusedB) {
    return { status: 'unused', reason: 'no_connection_marker',
      unusedSide: unusedA && unusedB ? 'both' : unusedA ? 'a' : 'b' };
  }
  const equalNames = foldName(nameA) === foldName(nameB);
  if (equalNames && !AUTO_NUMBERED_NAME.test(nameA.trim())) return { status: 'same', reason: 'names_equal' };
  if (!equalNames) {
    const groundA = GROUND_NAME.test(foldName(nameA)) || sideA.is_ground === true;
    const groundB = GROUND_NAME.test(foldName(nameB)) || sideB.is_ground === true;
    if (groundA && groundB) return { status: 'equivalent_rail', reason: 'ground_alias' };
    const railA = railIdentity(nameA);
    if (railA && railA === railIdentity(nameB)) return { status: 'equivalent_rail', reason: 'rail_name_match' };
  }
  const evidence = connectivity(run, pinA, pinB);
  const matches = evidence.jaccard !== null && evidence.jaccard >= RENAME_JACCARD_THRESHOLD;
  if (equalNames) {
    // Numbered name: connectivity decides. Nothing else attached on either
    // side leaves nothing to contradict the equal name.
    const noEvidence = evidence.shared + evidence.onlyA + evidence.onlyB === 0;
    return matches || noEvidence
      ? { status: 'same', reason: 'auto_name_connectivity_match', evidence }
      : { status: 'different', reason: 'auto_name_collision', evidence };
  }
  return matches
    ? { status: 'renamed', reason: 'connectivity_match', evidence }
    : { status: 'different', reason: 'names_and_connectivity_differ', evidence };
}

function groupPins(index, refs) {
  const groups = new Map();
  for (const ref of refs) {
    const key = pinKey(index.board.pins[ref]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ref);
  }
  return groups;
}

// Several pads can share one name (thermal pads, "GND"). Pair identical nets
// first so an ordering difference between exports can't read as a fault.
function pairGroup(run, refsA, refsB) {
  if (refsA.length <= 1 && refsB.length <= 1) return [[refsA[0] ?? null, refsB[0] ?? null]];
  const pairs = [], leftoverA = [], freeB = new Map();
  const netOf = (index, ref) => foldName(index.board.pins[ref].net ?? '');
  for (const ref of refsB) {
    const net = netOf(run.b, ref);
    if (!freeB.has(net)) freeB.set(net, []);
    freeB.get(net).push(ref);
  }
  for (const ref of refsA) {
    const match = freeB.get(netOf(run.a, ref))?.shift();
    if (match === undefined) leftoverA.push(ref); else pairs.push([ref, match]);
  }
  const leftoverB = [...freeB.values()].flat().sort((x, y) => x - y);
  const count = Math.max(leftoverA.length, leftoverB.length);
  for (let i = 0; i < count; i += 1) pairs.push([leftoverA[i] ?? null, leftoverB[i] ?? null]);
  return pairs;
}

function emptySummary() {
  const summary = { total: 0, differing: 0, jaccardThreshold: RENAME_JACCARD_THRESHOLD, warnings: [] };
  for (const status of STATUSES) summary[status] = 0;
  return summary;
}

function partInfo(index, refdes) {
  const part = index.parts.get(refdes);
  if (!part) return null;
  const info = { refdes: part.refdes, is_dnp: part.is_dnp ?? false,
    pinCount: index.partPins.get(refdes)?.length ?? 0 };
  if (part.value != null) info.value = part.value;
  if (part.footprint != null) info.footprint = part.footprint;
  return info;
}

const labelOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Compare `refdesA` on `boardA` with `refdesB` on `boardB`.
 * Each row side carries `pinRef` (position in `board.pins`, the value used in
 * `part.pin_refs`) and only the expected readings the board really contains.
 * An unknown refdes returns `found: false` with empty rows.
 */
export function comparePinout(boardA, refdesA, boardB, refdesB) {
  const run = { a: boardIndex(boardA), b: boardIndex(boardB), intersections: new Map() };
  const summary = emptySummary();
  const parts = { a: partInfo(run.a, refdesA), b: partInfo(run.b, refdesB) };
  if (!parts.a || !parts.b) {
    return { found: false, reason: 'part_not_found',
      missing: [...(parts.a ? [] : ['a']), ...(parts.b ? [] : ['b'])], parts, rows: [], summary };
  }
  const groupsA = groupPins(run.a, run.a.partPins.get(refdesA) ?? []);
  const groupsB = groupPins(run.b, run.b.partPins.get(refdesB) ?? []);
  const rows = [];
  let commonLabels = 0;
  for (const key of new Set([...groupsA.keys(), ...groupsB.keys()])) {
    const refsA = groupsA.get(key) ?? [], refsB = groupsB.get(key) ?? [];
    if (refsA.length && refsB.length) commonLabels += 1;
    const pairs = pairGroup(run, refsA, refsB);
    pairs.forEach(([refA, refB], position) => {
      const a = refA === null ? null : pinSide(run.a, refA);
      const b = refB === null ? null : pinSide(run.b, refB);
      const verdict = a && b
        ? classify(run, boardA.pins[refA], boardB.pins[refB], a, b)
        : { status: 'missing', reason: a ? 'pin_absent_on_b' : 'pin_absent_on_a' };
      const row = { pin: (a ?? b).label, a, b, ...verdict };
      if (pairs.length > 1) row.occurrence = position + 1;
      rows.push(row);
    });
  }
  rows.sort((x, y) => labelOrder.compare(x.pin, y.pin) || (x.occurrence ?? 0) - (y.occurrence ?? 0));
  for (const row of rows) summary[row.status] += 1;
  summary.total = rows.length;
  summary.differing = DIFFERING_STATUSES.reduce((sum, status) => sum + summary[status], 0);
  if (groupsA.size && groupsB.size && !commonLabels) summary.warnings.push('no_common_pin_labels');
  return { found: true, parts, rows, summary };
}

/** `board.pins` positions of the genuinely differing pins on one side. */
export function differingPinRefs(result, side = 'a') {
  return result.rows
    .filter(row => DIFFERING_STATUSES.includes(row.status) && row[side])
    .map(row => row[side].pinRef);
}
