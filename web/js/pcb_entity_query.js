/**
 * Pure part and net filter. Every non-empty line is an AND filter of one kind:
 *   glob      contains `*`; matches a whole field (refdes, value or footprint)
 *   quantity  only electrical values ("20uF", "4k7", "20uF 10V"); compared by
 *             magnitude against the part value, substring elsewhere
 *   text      anything else; substring of refdes, value or footprint
 * Nets only have a name, so every kind degrades to text or glob on `net.name`.
 */

const UNITS = 'ohms?|hz|f|h|v|a|w|r';
const NUMBER_START = '(?<![a-z0-9.])';
const NUMBER_END = '(?![a-z0-9])';
// "4k7", "2u2", "3V3", "4R7", optionally followed by a unit ("4u7F").
const RKM = `(\\d+)([pnumkgrv])(\\d+)(?:(${UNITS}))?`;
// "20uF", "20 uF", "4.7k", "10V", "100n".
const PLAIN = `(\\d+(?:\\.\\d+)?)\\s*([pnumkg])?\\s*(${UNITS})?`;
const QUANTITY = new RegExp(`${NUMBER_START}(?:${RKM}|${PLAIN})${NUMBER_END}`, 'gi');

const SEPARATORS = /^[\s/,;]*$/;
const MAX_CACHED_VALUES = 50000;
const quantityCache = new Map();

/** Fold the spellings of micro and ohm, keeping case for the milli/mega split. */
function foldUnits(text) {
  return text.replace(/[\u00b5\u03bc]/g, 'u').replace(/[\u03a9\u2126]/g, 'ohm');
}

const normalize = text => foldUnits(text).toLowerCase();
// Keeps m/M distinct so the fused-text fallback cannot confuse 1M with 1m.
const collapse = text => foldUnits(text).replace(/\s+/g, '').replace(/[^mM]/g, char => char.toLowerCase());

function canonicalUnit(unit) {
  const lower = (unit || '').toLowerCase();
  return lower === 'r' || lower.startsWith('ohm') ? 'ohm' : lower;
}

/** `m` is case-sensitive only where both milli and mega make physical sense. */
function multiplier(prefix, unit) {
  switch (prefix) {
    case 'p': case 'P': return 1e-12;
    case 'n': case 'N': return 1e-9;
    case 'u': case 'U': return 1e-6;
    case 'k': case 'K': return 1e3;
    case 'g': case 'G': return 1e9;
    case 'm': case 'M':
      if (unit === 'hz') return 1e6;
      if (unit === 'f' || unit === 'h' || unit === 'v' || unit === 'a' || unit === 'w') return 1e-3;
      return prefix === 'M' ? 1e6 : 1e-3;
    default: return 1;
  }
}

function quantityFromMatch(match) {
  const [, whole, marker, fraction, rkmUnit, number, prefix, plainUnit] = match;
  if (whole !== undefined) {
    const letter = marker.toLowerCase();
    if (letter === 'r' || letter === 'v') {
      return { magnitude: Number(`${whole}.${fraction}`), unit: letter === 'r' ? 'ohm' : 'v' };
    }
    const unit = canonicalUnit(rkmUnit);
    return { magnitude: Number(`${whole}.${fraction}`) * multiplier(marker, unit), unit };
  }
  if (!prefix && !plainUnit) return null;
  const unit = canonicalUnit(plainUnit);
  return { magnitude: Number(number) * multiplier(prefix, unit), unit };
}

function extractQuantities(text) {
  const quantities = [];
  for (const match of foldUnits(text).matchAll(QUANTITY)) {
    const quantity = quantityFromMatch(match);
    if (quantity) quantities.push(quantity);
  }
  return quantities;
}

function cachedQuantities(value) {
  let quantities = quantityCache.get(value);
  if (quantities === undefined) {
    if (quantityCache.size >= MAX_CACHED_VALUES) quantityCache.clear();
    quantities = extractQuantities(value);
    quantityCache.set(value, quantities);
  }
  return quantities;
}

function sameQuantity(a, b) {
  if (a.unit && b.unit && a.unit !== b.unit) return false;
  return Math.abs(a.magnitude - b.magnitude) <= 1e-9 * Math.max(Math.abs(a.magnitude), Math.abs(b.magnitude));
}

/** Substring that does not start or end inside a number ("20uf" is not in "120uf"). */
function includesAtNumberBoundary(haystack, needle) {
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    const clearBefore = before === undefined || !/[0-9.]/.test(before);
    const clearAfter = after === undefined || !/[a-zA-Z]/.test(after);
    if (clearBefore && clearAfter) return true;
  }
  return false;
}

function parseQuantityLine(line) {
  const folded = foldUnits(line);
  const terms = [];
  let residue = '';
  let position = 0;
  for (const match of folded.matchAll(QUANTITY)) {
    const quantity = quantityFromMatch(match);
    if (!quantity) return null;
    residue += folded.slice(position, match.index);
    position = match.index + match[0].length;
    terms.push({ quantity, compact: collapse(match[0]) });
  }
  residue += folded.slice(position);
  return terms.length && SEPARATORS.test(residue) ? terms : null;
}

function compileGlob(line) {
  const source = normalize(line).replace(/\*+/g, '*').split('*')
    .map(piece => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`, 's');
}

function parseLine(line) {
  const text = normalize(line);
  if (line.includes('*')) return { kind: 'glob', text, regex: compileGlob(line) };
  const terms = parseQuantityLine(line);
  return terms ? { kind: 'quantity', text, terms } : { kind: 'text', text };
}

/** Compile `text` once; pass the result to matchesPart / matchesNet per entity. */
export function parseQuery(text) {
  const source = typeof text === 'string' ? text : '';
  return {
    filters: source.split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean).map(parseLine),
  };
}

function termMatchesValue(term, value) {
  if (cachedQuantities(value).some(candidate => sameQuantity(term.quantity, candidate))) return true;
  return includesAtNumberBoundary(collapse(value), term.compact);
}

function filterMatchesPart(filter, refdes, value, footprint) {
  if (filter.kind === 'glob') {
    return filter.regex.test(refdes) || filter.regex.test(normalize(value)) || filter.regex.test(footprint);
  }
  if (refdes.includes(filter.text) || footprint.includes(filter.text)) return true;
  if (filter.kind === 'text') return normalize(value).includes(filter.text);
  return filter.terms.every(term => termMatchesValue(term, value));
}

export function matchesPart(query, part) {
  const { filters } = query;
  if (!filters.length) return true;
  const refdes = normalize(part.refdes || '');
  const value = part.value || '';
  const footprint = normalize(part.footprint || '');
  return filters.every(filter => filterMatchesPart(filter, refdes, value, footprint));
}

export function matchesNet(query, net) {
  const { filters } = query;
  if (!filters.length) return true;
  const name = normalize(net.name || '');
  return filters.every(filter => (filter.kind === 'glob' ? filter.regex.test(name) : name.includes(filter.text)));
}
