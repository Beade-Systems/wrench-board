// Run with: node tests/js/test_entity_query.mjs
// Also covers the sibling pure modules (net walk, colour rule resolution).
import assert from 'node:assert/strict';
import { matchesNet, matchesPart, parseQuery } from '../../web/js/pcb_entity_query.js';
import { adjacentNets, MAX_WALK_NET_PINS } from '../../web/js/pcb_net_walk.js';
import { DEFAULT_RULES, loadRules, resolve, saveRules } from '../../web/js/pcb_color_rules.js';

const part = (refdes, value = null, footprint = null) => ({ refdes, value, footprint });
const hits = (text, candidate) => matchesPart(parseQuery(text), candidate);
const tests = [];
const test = (name, body) => tests.push([name, body]);

test('empty queries match everything', () => {
  for (const text of ['', '  \n\t\r\n ', null, undefined]) {
    assert.equal(hits(text, part('R1')), true);
    assert.equal(matchesNet(parseQuery(text), { name: 'GND' }), true);
  }
});

test('capacitance is matched regardless of spelling', () => {
  for (const value of ['20uF', '20µF', '20μF', '20 uF', '20UF', '20 µF/25V', 'CAP 20UF', '0.02mF', '20000nF']) {
    assert.equal(hits('20uF', part('C1', value)), true, value);
  }
  for (const query of ['20µF', '20 uF', '20UF', '20 UF']) assert.equal(hits(query, part('C1', '20uF')), true, query);
});

test('a quantity does not match a different quantity', () => {
  for (const value of ['120uF', '2uF', '20nF', '20uH', '200uF', '20.5uF']) {
    assert.equal(hits('20uF', part('C1', value)), false, value);
  }
});

test('compact and fused spellings still find the quantity', () => {
  assert.equal(hits('10uF', part('C1', '10UF16V')), true);
  assert.equal(hits('16V', part('C1', '10UF16V')), true);
  assert.equal(hits('20uF', part('C1', 'X120UF')), false);
});

test('voltage', () => {
  assert.equal(hits('10V', part('C1', '100nF 10V')), true);
  assert.equal(hits('10V', part('C1', '100nF 110V')), false);
  assert.equal(hits('10V', part('C1', '100nF 16V')), false);
  assert.equal(hits('3V3', part('U1', '3.3V LDO')), true);
  assert.equal(hits('3.3V', part('U1', '3V3')), true);
});

test('RKM notation equals the decimal form', () => {
  for (const [query, value] of [['4k7', '4.7k'], ['4.7k', '4k7'], ['4K7', '4.7K'], ['4k7', '4700R'], ['4k7', '4.7kΩ'],
    ['4R7', '4.7R'], ['4R7', '4.7 ohm'], ['2u2', '2.2uF'], ['2.2uF', '2u2'], ['1M5', '1.5M'], ['100n', '0.1uF'], ['1k', '1.0K']]) {
    assert.equal(hits(query, part('X1', value)), true, `${query} = ${value}`);
  }
  assert.equal(hits('4k7', part('R1', '47k')), false);
  assert.equal(hits('4k7', part('R1', '4.7M')), false);
});

test('milli and mega are told apart only where it matters', () => {
  assert.equal(hits('1M', part('R1', '1m')), false);
  assert.equal(hits('1m', part('R1', '1mOhm')), true);
  assert.equal(hits('1M', part('R1', '1MOhm')), true);
  assert.equal(hits('10mH', part('L1', '10MH')), true);
  assert.equal(hits('24MHz', part('Y1', '24mhz')), true);
});

test('a prefix without unit accepts any unit, explicit units must agree', () => {
  assert.equal(hits('100n', part('C1', '100nF')), true);
  assert.equal(hits('100nF', part('C1', '100n')), true);
  assert.equal(hits('100nF', part('L1', '100nH')), false);
});

test('several quantities on one line must all be present', () => {
  assert.equal(hits('20uF 10V', part('C1', '10V 20µF')), true);
  assert.equal(hits('20uF 10V', part('C1', '20µF 16V')), false);
  assert.equal(hits('20uF/10V', part('C1', '20 uF, 10 V')), true);
});

test('lines without wildcards are substrings of refdes, value and footprint', () => {
  const candidate = part('U7000', 'TPS51125', 'QFN-32_5x5');
  for (const text of ['U7', '7000', 'u700', 'tps51', 'qfn-32', '5x5']) assert.equal(hits(text, candidate), true, text);
  assert.equal(hits('U8', candidate), false);
  assert.equal(hits('R1', part('R12')), true);
  assert.equal(hits('0402', part('C1', '1uF', 'C_0402')), true);
  assert.equal(hits('100', part('C1', '100nF')), true);
});

test('quantity-like lines still match refdes and footprint as text', () => {
  assert.equal(hits('10V', part('TP10V')), true);
  assert.equal(hits('1k', part('C1', null, 'BGA1K')), true);
});

test('wildcards match a whole field', () => {
  assert.equal(hits('R*', part('R12')), true);
  assert.equal(hits('r1*', part('R12')), true);
  assert.equal(hits('*12', part('R12')), true);
  assert.equal(hits('R*2', part('R12')), true);
  assert.equal(hits('R*', part('CR12')), false);
  assert.equal(hits('*uF', part('C1', '20µF')), true);
  assert.equal(hits('QFN*', part('U1', null, 'QFN-32')), true);
  assert.equal(hits('a.b*', part('axb1')), false);
  assert.equal(hits('(*', part('(x')), true);
  assert.equal(hits('**R**', part('R')), true);
});

test('lines are AND filters', () => {
  const candidate = part('C12', '20uF', '0603');
  assert.equal(hits('C*\n20uF\n0603', candidate), true);
  assert.equal(hits('C*\r\n\r\n  20uF  \r\n', candidate), true);
  assert.equal(hits('C*\n22uF', candidate), false);
  assert.equal(hits('R*\n20uF', candidate), false);
});

test('missing fields do not throw', () => {
  assert.equal(hits('10uF', part('C1')), false);
  assert.equal(hits('*x*', {}), false);
  assert.equal(hits('foo', { refdes: 'C1', value: undefined }), false);
});

test('nets match by name only', () => {
  const query = text => parseQuery(text);
  assert.equal(matchesNet(query('pp3v3'), { name: 'PP3V3_S0' }), true);
  assert.equal(matchesNet(query('3V3'), { name: 'PP3V3_S0' }), true);
  assert.equal(matchesNet(query('PP*'), { name: 'PP3V3_S0' }), true);
  assert.equal(matchesNet(query('*S0\nPP*'), { name: 'PP3V3_S0' }), true);
  assert.equal(matchesNet(query('PP*\nGND'), { name: 'PP3V3_S0' }), false);
  assert.equal(matchesNet(query('VCC*'), { name: 'PP_VCC' }), false);
});

test('a query runs over 10k parts well inside a keystroke', () => {
  const values = ['20uF', '100nF 16V', '4.7k', '4K7 1%', 'TPS51125', '10UF16V'];
  const parts = Array.from({ length: 10000 }, (_, index) => ({
    refdes: `R${index}`, value: `${values[index % values.length]}-${index % 900}`, footprint: `C_${index % 40}`,
  }));
  let best = Infinity;
  for (let round = 0; round < 5; round++) {
    const started = performance.now();
    for (const text of ['20uF', 'R1*\n4k7', 'tps', '*0402*\n10V 20uF']) {
      const query = parseQuery(text);
      parts.filter(candidate => matchesPart(query, candidate));
    }
    best = Math.min(best, (performance.now() - started) / 4);
  }
  assert.ok(best < 16, `${best.toFixed(2)} ms per query`);
});

function walkBoard() {
  const nets = [];
  const pins = [];
  const parts = [];
  const net = (name, flags = {}) => { nets.push({ name, pin_refs: [], ...flags }); };
  const addPart = (refdes, names, extra = {}) => {
    const pin_refs = names.map(name => {
      pins.push({ part_refdes: refdes, net: name });
      nets.find(candidate => candidate.name === name)?.pin_refs.push(pins.length - 1);
      return pins.length - 1;
    });
    parts.push({ refdes, pin_refs, ...extra });
  };
  net('A'); net('B'); net('C'); net('D'); net('E');
  net('GND', { is_ground: true }); net('PP5V', { is_power: true }); net('BUS');
  addPart('R1', ['A', 'B']);
  addPart('L1', ['B', 'C']);
  addPart('FB1', ['C', 'D']);
  addPart('R2', ['A', 'GND']);
  addPart('R3', ['A', 'PP5V']);
  addPart('R4', ['PP5V', 'E']);
  addPart('C1', ['A', 'E']);
  addPart('J1', ['A', 'E']);
  addPart('U1', ['A', 'E', 'D']);
  addPart('R5', ['A', 'A']);
  addPart('R6', ['A', 'E'], { is_dnp: true });
  addPart('R7', ['A', null]);
  addPart('R8', ['A', 'BUS']);
  addPart('R9', ['BUS', 'E']);
  for (let index = 0; index < MAX_WALK_NET_PINS; index++) addPart(`TP${index}`, ['BUS']);
  return { nets, pins, parts };
}

test('net walk follows two-terminal passives only', () => {
  assert.deepEqual([...adjacentNets(walkBoard(), 'A')], [['B', 1]]);
});

test('net walk reports hop count up to the depth', () => {
  const board = walkBoard();
  assert.deepEqual([...adjacentNets(board, 'A', 2)], [['B', 1], ['C', 2]]);
  assert.deepEqual([...adjacentNets(board, 'A', 9)], [['B', 1], ['C', 2], ['D', 3]]);
  assert.deepEqual([...adjacentNets(board, 'D', 2)], [['C', 1], ['B', 2]]);
});

test('net walk never crosses or returns ground, power or high-fanout nets', () => {
  const board = walkBoard();
  const reached = adjacentNets(board, 'A', 9);
  for (const name of ['GND', 'PP5V', 'BUS', 'E']) assert.equal(reached.has(name), false, name);
  assert.equal(adjacentNets(board, 'GND', 3).size, 0);
  assert.equal(adjacentNets(board, 'BUS', 3).size, 0);
  assert.deepEqual([...adjacentNets(board, 'BUS', 1, { maxPins: 1000 })], [['A', 1], ['E', 1]]);
});

test('an explicitly chosen power net can be the start of a walk', () => {
  assert.deepEqual([...adjacentNets(walkBoard(), 'PP5V')], [['A', 1], ['E', 1]]);
});

test('net walk handles unknown input and invalid depth', () => {
  const board = walkBoard();
  assert.equal(adjacentNets(board, 'NOPE').size, 0);
  assert.equal(adjacentNets(board, null).size, 0);
  assert.equal(adjacentNets(null, 'A').size, 0);
  assert.equal(adjacentNets(board, 'A', 0).size, 0);
});

const colorBoard = () => ({
  nets: [{ name: 'GND' }, { name: 'PP3V3' }, { name: 'SIG' }],
  parts: [{ refdes: 'R1', layer: 1 }, { refdes: 'U12', layer: 2 }, { refdes: 'TP1', layer: 1 }],
  pins: [{ net: 'GND', layer: 1 }, { net: 'SIG', layer: 1 }, { net: null, layer: 2 }, { net: 'vcc_x', layer: 2 }],
  traces: [{ net: 'pp3v3' }, { net: 'SIG' }],
  vias: [{ net: 'GND' }],
  test_pads: [{ net: 'SIG' }],
});

test('colour rules resolve into arrays parallel to the board', () => {
  const resolved = resolve(colorBoard(), DEFAULT_RULES);
  const { components, sides, nets } = DEFAULT_RULES;
  assert.deepEqual(resolved.partFill, [`${components.R}99`, `${components.U}99`, `${sides.top}99`]);
  assert.deepEqual(resolved.partStroke, [sides.top, sides.bottom, sides.top]);
  assert.deepEqual(resolved.pinFill, [nets[0].color, sides.top, sides.bottom, nets[1].color]);
  assert.deepEqual(resolved.traceStroke, [nets[2].color, null]);
  assert.deepEqual(resolved.viaStroke, [nets[0].color]);
  assert.deepEqual(resolved.testPadStroke, [null]);
});

test('the first matching net rule wins and regex characters are literal', () => {
  const rules = { nets: [{ pattern: 'A.B', color: '#111111' }, { pattern: 'A*', color: '#222222' }, { pattern: 'AX*', color: '#333333' }] };
  const board = { nets: [{ name: 'A.B' }, { name: 'AXB' }], parts: [], pins: [] };
  assert.equal(resolve(board, rules).nets.get('A.B'), '#111111');
  assert.equal(resolve(board, rules).nets.get('AXB'), '#222222');
});

test('malformed colour rules fall back instead of throwing', () => {
  const resolved = resolve(colorBoard(), { nets: [{ pattern: '', color: '#123456' }, { pattern: 'SIG', color: 'red' }, null], sides: { top: 'x' } });
  assert.equal(resolved.pinFill[1], DEFAULT_RULES.sides.top);
  resolve(colorBoard(), null);
});

test('rule storage survives a missing or broken localStorage', () => {
  delete globalThis.localStorage;
  assert.deepEqual(loadRules().sides, DEFAULT_RULES.sides);
  assert.equal(saveRules(DEFAULT_RULES), false);
  const memory = new Map();
  globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  const custom = { nets: [{ pattern: 'X*', color: '#010203' }], components: { R: '#040506' }, sides: { top: '#070809', bottom: '#0a0b0c' } };
  assert.equal(saveRules(custom), true);
  assert.deepEqual(loadRules(), custom);
  memory.set([...memory.keys()][0], '{broken');
  assert.deepEqual(loadRules().sides, DEFAULT_RULES.sides);
  delete globalThis.localStorage;
});

let failed = 0;
for (const [name, body] of tests) {
  try {
    body();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.log(`not ok - ${name}\n  ${error.message}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed ? 1 : 0;
