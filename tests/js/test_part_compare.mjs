// Run with: node tests/js/test_part_compare.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  comparePinout, differingPinRefs, isUnusedNetName, railIdentity,
  RENAME_JACCARD_THRESHOLD, STATUSES,
} from '../../web/js/pcb_part_compare.js';

// spec: { U1: { 1: 'NET', ... }, R1: { 1: 'NET' } }; pin keys become pin names.
function makeBoard(spec, netFields = {}) {
  const pins = [], parts = [], members = new Map();
  for (const [refdes, pinMap] of Object.entries(spec)) {
    const pin_refs = [];
    Object.entries(pinMap).forEach(([name, net], position) => {
      pin_refs.push(pins.length);
      if (net) {
        if (!members.has(net)) members.set(net, []);
        members.get(net).push(pins.length);
      }
      pins.push({ part_refdes: refdes, index: position + 1, name, net, layer: 1, pos: { x: position, y: 0 } });
    });
    parts.push({ refdes, layer: 1, is_smd: true, pin_refs, value: `${refdes}-value`, is_dnp: false });
  }
  const nets = [...members].map(([name, pin_refs]) => ({
    name, pin_refs, is_power: false, is_ground: false,
    expected_resistance_ohms: null, expected_open: false, expected_voltage_v: null,
    ...netFields[name],
  }));
  return { pins, parts, nets };
}

const statusOf = (result, pin) => result.rows.find(row => row.pin === pin).status;

function comparePin(netA, netB, extraA = {}, extraB = {}) {
  const a = makeBoard({ U1: { 1: netA }, ...extraA });
  const b = makeBoard({ U1: { 1: netB }, ...extraB });
  return comparePinout(a, 'U1', b, 'U1').rows[0];
}

test('same: equal net names', () => {
  assert.equal(comparePin('I2C_SDA', 'I2C_SDA').status, 'same');
  assert.equal(comparePin('i2c_sda ', 'I2C_SDA').status, 'same');
});

test('renamed: different names, same endpoints above the threshold', () => {
  const a = makeBoard({ U1: { 1: 'SIG_A' }, R1: { 1: 'SIG_A' }, R2: { 1: 'SIG_A' }, C1: { 2: 'SIG_A' } });
  const b = makeBoard({ U1: { 1: 'SIG_B' }, R1: { 1: 'SIG_B' }, R2: { 1: 'SIG_B' }, C1: { 2: 'SIG_B' } });
  const row = comparePinout(a, 'U1', b, 'U1').rows[0];
  assert.equal(row.status, 'renamed');
  assert.deepEqual(row.evidence, { shared: 3, onlyA: 0, onlyB: 0, jaccard: 1 });
});

test('renamed boundary: exactly the threshold passes, just below does not', () => {
  assert.equal(RENAME_JACCARD_THRESHOLD, 0.6);
  const shared = { R1: { 1: 'S' }, R2: { 1: 'S' }, R3: { 1: 'S' } };
  const withNet = (spec, net) => Object.fromEntries(Object.entries(spec).map(
    ([ref, pinMap]) => [ref, Object.fromEntries(Object.keys(pinMap).map(p => [p, net]))]));
  const a = makeBoard({ U1: { 1: 'AA' }, ...withNet(shared, 'AA'), R4: { 1: 'AA' }, R5: { 1: 'AA' } });
  const b = makeBoard({ U1: { 1: 'BB' }, ...withNet(shared, 'BB') });
  const atThreshold = comparePinout(a, 'U1', b, 'U1').rows[0];
  assert.equal(atThreshold.evidence.jaccard, 0.6);
  assert.equal(atThreshold.status, 'renamed');
  const c = makeBoard({ U1: { 1: 'AA' }, ...withNet(shared, 'AA'), R4: { 1: 'AA' }, R5: { 1: 'AA' }, R6: { 1: 'AA' } });
  assert.equal(comparePinout(c, 'U1', b, 'U1').rows[0].status, 'different');
});

test('renamed needs other endpoints: the compared pin alone is no evidence', () => {
  const row = comparePin('LONELY_A', 'LONELY_B');
  assert.equal(row.status, 'different');
  assert.equal(row.evidence.jaccard, null);
});

test('renamed excludes the compared pin when refdes differ across boards', () => {
  // On B, U2.1 is the compared pin and U1.1 is an ordinary endpoint. U1.1 is
  // A's own compared pin, so the overlap must not count as evidence.
  const a = makeBoard({ U1: { 1: 'NET_A' }, R1: { 1: 'NET_A' } });
  const b = makeBoard({ U2: { 1: 'NET_B' }, U1: { 1: 'NET_B' }, R9: { 1: 'NET_B' } });
  const row = comparePinout(a, 'U1', b, 'U2').rows[0];
  assert.equal(row.status, 'different');
  assert.equal(row.evidence.shared, 0);
});

test('equivalent_rail: naming conventions and ground aliases', () => {
  for (const [x, y] of [
    ['PP3V3_S0', '3V3_S0'], ['+3.3V', '3V3'], ['VCC_3V3', '3V3'], ['VDD_1V8', '+1.8V'],
    ['PP1P8', '1V8'], ['P5V_SB', '5VSB'], ['+1.35V', '1V35'], ['12V0', '+12V'],
    ['GND', 'VSS'], ['GND', 'AGND'], ['gnd', 'GROUND'],
  ]) {
    assert.equal(comparePin(x, y).status, 'equivalent_rail', `${x} vs ${y}`);
  }
});

test('equivalent_rail must not merge different rails', () => {
  for (const [x, y] of [
    ['PP3V3_S0', 'PP3V3_S5'], ['3V3', '5V'], ['+5V', '-5V'], ['PP3V3_S0', '3V3'],
    ['P1.2', '1V2'], ['VIN0', '0V'], ['VCC', 'VDD'], ['GND', 'NCTSA-'], ['VCC-5V', '5V'],
  ]) {
    assert.equal(comparePin(x, y).status, 'different', `${x} vs ${y}`);
  }
});

test('railIdentity normalises value and domain', () => {
  assert.equal(railIdentity('PP3V3_S0'), '3300|S0');
  assert.equal(railIdentity('+3.3V'), '3300|');
  assert.equal(railIdentity('RTC_X1'), null);
  assert.equal(railIdentity('1P8'), null);
});

test('unused: NC markers on either side never read as a fault', () => {
  for (const marker of ['NC', 'N/C', 'nc', 'NC_1013', 'DNC', 'Net-(U1-Pad3)', 'NET-(R1-PAD1)', 'unconnected-(U1-NC-Pad3)', '', null]) {
    const row = comparePin(marker, 'SOME_SIGNAL');
    assert.equal(row.status, 'unused', String(marker));
    assert.equal(row.unusedSide, 'a');
  }
  assert.equal(comparePin('SOME_SIGNAL', 'NC').unusedSide, 'b');
  const both = comparePin('NC', 'NC');
  assert.equal(both.status, 'unused');
  assert.equal(both.unusedSide, 'both');
});

test('unused marker detection keeps look-alike signal names', () => {
  for (const name of ['NCTSA-', 'NCP_3V3', 'NC_SPI', 'NONE_SIGNAL', 'NETWORK_RST']) {
    assert.equal(isUnusedNetName(name), false, name);
  }
});

test('different: names and connectivity disagree', () => {
  const row = comparePinout(
    makeBoard({ U1: { 1: 'AAA' }, R1: { 1: 'AAA' } }), 'U1',
    makeBoard({ U1: { 1: 'BBB' }, R2: { 1: 'BBB' } }), 'U1',
  ).rows[0];
  assert.equal(row.status, 'different');
  assert.equal(row.reason, 'names_and_connectivity_differ');
});

test('auto-numbered names: connectivity decides even when the names are equal', () => {
  const a = makeBoard({ U1: { 1: 'Net1000' }, R1: { 1: 'Net1000' } });
  const collide = makeBoard({ U1: { 1: 'Net1000' }, R2: { 1: 'Net1000' } });
  const collision = comparePinout(a, 'U1', collide, 'U1').rows[0];
  assert.equal(collision.status, 'different');
  assert.equal(collision.reason, 'auto_name_collision');
  const genuine = makeBoard({ U1: { 1: 'Net1000' }, R1: { 1: 'Net1000' } });
  assert.equal(comparePinout(a, 'U1', genuine, 'U1').rows[0].status, 'same');
  const renumbered = makeBoard({ U1: { 1: 'Net77' }, R1: { 1: 'Net77' } });
  assert.equal(comparePinout(a, 'U1', renumbered, 'U1').rows[0].status, 'renamed');
  assert.equal(comparePin('Net5', 'Net5').status, 'same');
});

test('schematic-derived numeric names keep their identity when endpoints drift', () => {
  const row = comparePinout(
    makeBoard({ U1: { 1: 'N193761300' }, R1: { 1: 'N193761300' } }), 'U1',
    makeBoard({ U1: { 1: 'N193761300' }, R2: { 1: 'N193761300' } }), 'U1',
  ).rows[0];
  assert.equal(row.status, 'same');
});

test('missing: pin only on one side, with the absent side null', () => {
  const result = comparePinout(
    makeBoard({ U1: { 1: 'A', 2: 'B' } }), 'U1',
    makeBoard({ U1: { 1: 'A', 3: 'C' } }), 'U1',
  );
  assert.equal(statusOf(result, '2'), 'missing');
  assert.equal(result.rows.find(row => row.pin === '2').b, null);
  assert.equal(statusOf(result, '3'), 'missing');
  assert.equal(result.rows.find(row => row.pin === '3').a, null);
  assert.deepEqual(differingPinRefs(result, 'a'), [1]);
});

test('every status is reachable and the summary adds up', () => {
  const a = makeBoard({
    U1: { 1: 'SIG', 2: 'RN_A', 3: 'PP3V3_S0', 4: 'NC', 5: 'AAA', 6: 'ONLY' },
    R1: { 1: 'RN_A' }, R2: { 1: 'AAA' },
  });
  const b = makeBoard({
    U1: { 1: 'SIG', 2: 'RN_B', 3: '3V3_S0', 4: 'LIVE', 5: 'BBB' },
    R1: { 1: 'RN_B' }, R3: { 1: 'BBB' },
  });
  const { rows, summary } = comparePinout(a, 'U1', b, 'U1');
  assert.deepEqual(rows.map(row => row.status),
    ['same', 'renamed', 'equivalent_rail', 'unused', 'different', 'missing']);
  assert.deepEqual([...new Set(rows.map(row => row.status))].sort(), [...STATUSES].sort());
  assert.equal(summary.total, 6);
  assert.equal(summary.differing, 2);
  for (const status of STATUSES) assert.equal(summary[status], 1, status);
});

test('pins pair by name, not by position, and sort naturally', () => {
  const a = makeBoard({ U1: { B2: 'X', A10: 'Y', A2: 'Z' } });
  const b = makeBoard({ U1: { A2: 'Z', B2: 'X', a10: 'Y' } });
  const result = comparePinout(a, 'U1', b, 'U1');
  assert.deepEqual(result.rows.map(row => row.pin), ['A2', 'A10', 'B2']);
  assert.equal(result.summary.same, 3);
});

test('pin labels: zero padding is ignored and unnamed pins fall back to index', () => {
  const a = makeBoard({ U1: { '01': 'X' } });
  const b = makeBoard({ U1: { 1: 'X' } });
  b.pins[0].name = null;
  assert.equal(comparePinout(a, 'U1', b, 'U1').summary.same, 1);
});

test('no shared labels reports missing rows plus a warning, never a guessed pairing', () => {
  const a = makeBoard({ U1: { A1: 'X', A2: 'Y' } });
  const b = makeBoard({ U1: { 1: 'X', 2: 'Y' } });
  const { rows, summary } = comparePinout(a, 'U1', b, 'U1');
  assert.equal(rows.length, 4);
  assert.ok(rows.every(row => row.status === 'missing'));
  assert.deepEqual(summary.warnings, ['no_common_pin_labels']);
});

test('duplicate pin names pair identical nets first', () => {
  const dup = (ref, nets) => ({
    pins: nets.map((net, i) => ({ part_refdes: ref, index: i + 1, name: 'EP', net, layer: 1, pos: { x: i, y: 0 } })),
    parts: [{ refdes: ref, layer: 1, is_smd: true, pin_refs: nets.map((_, i) => i) }],
    nets: [],
  });
  const result = comparePinout(dup('U1', ['GND', 'SIG', 'GND']), 'U1', dup('U1', ['SIG', 'GND']), 'U1');
  assert.equal(result.summary.same, 2);
  assert.equal(result.summary.missing, 1);
  assert.deepEqual(result.rows.map(row => row.occurrence), [1, 2, 3]);
});

test('expected readings come through only when the board has them', () => {
  const a = makeBoard({ U1: { 1: 'VB' , 2: 'OPEN', 3: 'NOPE' } }, {
    VB: { expected_voltage_v: 3.3, expected_resistance_ohms: 120.5 },
    OPEN: { expected_open: true },
  });
  const b = makeBoard({ U1: { 1: 'VB', 2: 'OPEN', 3: 'NOPE' } });
  const { rows } = comparePinout(a, 'U1', b, 'U1');
  assert.equal(rows[0].a.expected_voltage_v, 3.3);
  assert.equal(rows[0].a.expected_resistance_ohms, 120.5);
  assert.equal('expected_open' in rows[0].a, false);
  assert.equal(rows[1].a.expected_open, true);
  for (const field of ['expected_voltage_v', 'expected_resistance_ohms', 'expected_open']) {
    assert.equal(field in rows[0].b, false, field);
    assert.equal(field in rows[2].a, false, field);
  }
  assert.equal('diode' in rows[0].a, false);
});

test('a pin whose net is absent from board.nets exposes no invented readings', () => {
  const a = makeBoard({ U1: { 1: 'GHOST' } });
  a.nets = [];
  const { rows } = comparePinout(a, 'U1', makeBoard({ U1: { 1: 'GHOST' } }), 'U1');
  assert.equal(rows[0].status, 'same');
  assert.equal('is_power' in rows[0].a, false);
});

test('unknown refdes returns a structured not-found result', () => {
  const board = makeBoard({ U1: { 1: 'X' } });
  const result = comparePinout(board, 'U999', board, 'U1');
  assert.equal(result.found, false);
  assert.equal(result.reason, 'part_not_found');
  assert.deepEqual(result.missing, ['a']);
  assert.deepEqual(result.rows, []);
});

test('pinRef is the position in board.pins, usable for highlighting', () => {
  const a = makeBoard({ R1: { 1: 'K' }, U1: { 1: 'AAA', 2: 'BBB' } });
  const b = makeBoard({ U1: { 1: 'AAA', 2: 'ZZZ' }, R7: { 1: 'ZZZ' } });
  const result = comparePinout(a, 'U1', b, 'U1');
  assert.deepEqual(differingPinRefs(result, 'a'), [2]);
  assert.equal(a.pins[2].net, 'BBB');
});

test('input boards are not mutated', () => {
  const a = makeBoard({ U1: { 1: 'A' } });
  const before = JSON.stringify(a);
  comparePinout(a, 'U1', a, 'U1');
  assert.equal(JSON.stringify(a), before);
});

test('large boards stay fast and repeat runs reuse the index', () => {
  const big = (renamed) => {
    const spec = { U1: {} };
    for (let i = 1; i <= 2000; i += 1) spec.U1[i] = renamed ? `B_${i % 50}` : `A_${i % 50}`;
    for (let r = 0; r < 12000; r += 1) spec[`R${r}`] = { 1: renamed ? `B_${r % 50}` : `A_${r % 50}` };
    return makeBoard(spec);
  };
  const a = big(false), b = big(true);
  const started = performance.now();
  const result = comparePinout(a, 'U1', b, 'U1');
  const elapsed = performance.now() - started;
  assert.equal(result.summary.total, 2000);
  assert.equal(result.summary.renamed, 2000);
  assert.ok(elapsed < 3000, `took ${elapsed} ms`);
});
