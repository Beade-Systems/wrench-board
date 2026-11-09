/**
 * Pure net neighbourhood walk: which nets sit one or more two-terminal passives
 * away from a net. Ground, power and high-fanout nets never enter the result,
 * so one pull-up cannot light up a whole rail.
 */

/** Nets with more pins than this count as rails even when not flagged is_power. */
export const MAX_WALK_NET_PINS = 48;

// Connectors (J, CN) are deliberately absent: a 2-pin header is not a conductor.
const PASSIVE_PREFIXES = new Set(['R', 'L', 'FB', 'FL', 'JP', 'JMP', 'SJ', 'XW', 'NT', 'PR', 'PL', 'PJ']);

const indexes = new WeakMap();

function refdesPrefix(refdes) {
  return (/^[A-Za-z]+/.exec(refdes || '')?.[0] || '').toUpperCase();
}

function link(neighbours, from, to) {
  let set = neighbours.get(from);
  if (!set) neighbours.set(from, set = new Set());
  set.add(to);
}

function buildIndex(board) {
  const neighbours = new Map();
  for (const part of board.parts || []) {
    if (part.is_dnp || part.pin_refs?.length !== 2 || !PASSIVE_PREFIXES.has(refdesPrefix(part.refdes))) continue;
    const a = board.pins[part.pin_refs[0]]?.net;
    const b = board.pins[part.pin_refs[1]]?.net;
    if (!a || !b || a === b) continue;
    link(neighbours, a, b);
    link(neighbours, b, a);
  }
  const pinCounts = new Map();
  for (const pin of board.pins || []) {
    if (pin.net) pinCounts.set(pin.net, (pinCounts.get(pin.net) || 0) + 1);
  }
  const flags = new Map((board.nets || []).map(net => [net.name, net]));
  return { neighbours, pinCounts, flags };
}

function indexFor(board) {
  let index = indexes.get(board);
  if (!index) indexes.set(board, index = buildIndex(board));
  return index;
}

/**
 * Nets reachable from `netName` in at most `depth` passive hops, with the hop
 * count, nearest first. The start net itself is not included. A power net may
 * be the explicit start; ground and high-fanout nets yield an empty map.
 */
export function adjacentNets(board, netName, depth = 1, { maxPins = MAX_WALK_NET_PINS } = {}) {
  const result = new Map();
  if (!board || !netName || !(depth >= 1)) return result;
  const { neighbours, pinCounts, flags } = indexFor(board);
  const isHighFanout = name => (pinCounts.get(name) || 0) > maxPins;
  const isBlocked = name => flags.get(name)?.is_ground || flags.get(name)?.is_power || isHighFanout(name);
  if (flags.get(netName)?.is_ground || isHighFanout(netName)) return result;
  let frontier = [netName];
  for (let hop = 1; hop <= depth && frontier.length; hop++) {
    const next = [];
    for (const name of frontier) {
      for (const neighbour of neighbours.get(name) || []) {
        if (neighbour === netName || result.has(neighbour) || isBlocked(neighbour)) continue;
        result.set(neighbour, hop);
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return result;
}
