import test from 'node:test';
import assert from 'node:assert/strict';
import { createExample } from '../src/model/example';
import { CHANNELS } from '../src/model/channels';
import { fixed, endpoint } from '../src/model/types';
import { calculate, evaluate, scan } from '../src/engine/calculate';
import { connectionError, resolveInstances, traceLink } from '../src/engine/graph';
import { parseProject, serializeProject } from '../src/storage/project';

test('A5/A6: one shared fiber; -3 dB optical -> -6 dB RF; +3 dB -> +6 dB; fixed reference', () => {
  const p = createExample();
  const [a, b] = p.links;
  const base = calculate(p, a);
  assert.equal(base.status, 'ok');
  assert.equal(base.rfGainDb, -22); assert.equal(base.opticalPowerDbm, -2);
  assert.equal(calculate(p, b).rfGainDb, -22);
  for (const l of [a, b]) assert.ok(calculate(p, l).highlightConnections.includes('shared-fiber'));
  assert.equal(p.connections.filter(c => c.id === 'shared-fiber').length, 1);
  const table = p.components.find(c => c.id === 'attenuator')!.transfers[0].gainDb!;
  assert.equal(table.kind, 'channel');
  if (table.kind !== 'channel') throw new Error();
  table.values.DWDM_CH28 = -3;
  assert.equal(calculate(p, a).rfGainDb, -28);
  assert.equal(calculate(p, a).rfGainDb, -28);
  assert.equal(calculate(p, b).rfGainDb, -22);
  table.values.DWDM_CH28 = 3;
  assert.equal(calculate(p, a).rfGainDb, -16);
  assert.equal(a.conversion!.powerRefDbm, -2);
  assert.ok(base.highlightNodes.includes('tx28/laser'));
});

test('A4: definition reuse, legal independent overrides, shared definition update, hierarchical path', () => {
  const p = createExample();
  let resolved = resolveInstances(p);
  assert.equal(evaluate(resolved.find(i => i.id === 'tx28/laser')!.params.powerDbm, 1), 6);
  assert.equal(evaluate(resolved.find(i => i.id === 'tx30/laser')!.params.powerDbm, 1), 8);
  assert.equal(resolved.find(i => i.id === 'tx30/laser')!.params.channel, 'DWDM_CH30');
  p.instances.find(i => i.id === 'tx28')!.overrides.laserPowerDbm = fixed(9);
  resolved = resolveInstances(p);
  assert.equal(evaluate(resolved.find(i => i.id === 'tx28/laser')!.params.powerDbm, 1), 9);
  assert.equal(evaluate(resolved.find(i => i.id === 'tx30/laser')!.params.powerDbm, 1), 8);
  const before = p.links.slice(0, 2).map(l => calculate(p, l).rfGainDb!);
  p.modules[0].instances.find(i => i.id === 'mzm')!.overrides.opticalGainDb = fixed(-5);
  assert.deepEqual(p.links.slice(0, 2).map(l => calculate(p, l).rfGainDb!), before.map(g => g - 2));
  assert.ok(traceLink(p, p.links[0]).arcs.some(a => a.id === 'tx28/map-rf'));
});

test('A3: dynamic PCB port types, valid/invalid connections, explicit transfer only', () => {
  const p = createExample();
  const pcb = p.components.find(c => c.id === 'pcb')!;
  assert.deepEqual(new Set(pcb.ports.map(p => p.type)), new Set(['RF', 'OPTICAL', 'DC_POWER', 'CONTROL']));
  assert.equal(connectionError(p, endpoint('input28', 'rf'), endpoint('pcb', 'RF_IN')), undefined);
  assert.match(connectionError(p, endpoint('input28', 'rf'), endpoint('pcb', 'OPT_IN'))!, /类型不兼容/);
  assert.match(connectionError(p, endpoint('pcb', 'RF_IN'), endpoint('amp', 'in'))!, /方向不兼容/);
  assert.equal(calculate(p, p.links[3]).status, 'error');
  assert.equal(evaluate(pcb.transfers[1].gainDb, 1, 'DWDM_CH30'), -2);
  assert.equal(calculate(p, p.links[4]).status, 'ok');
  assert.equal(calculate(p, p.links[4]).opticalPowerDbm, .5);
  pcb.ports.push({ id: 'CTRL_AUX', direction: 'in', type: 'CONTROL' });
  assert.equal(connectionError(p, endpoint('control', 'out'), endpoint('pcb', 'CTRL_AUX')), undefined);
});

test('A7: 1 GHz scan and independent Friis NF reference', () => {
  const p = createExample();
  const result = scan(p, p.links[2]);
  assert.deepEqual(result.map(r => r.frequencyGHz), [1, 2, 3, 4, 5]);
  assert.deepEqual(result.map(r => r.rfGainDb), [16, 18, 20, 19, 18]);
  const expectedNF = 10 * Math.log10(10 ** (3 / 10) + (10 ** (4 / 10) - 1) / 10);
  assert.ok(Math.abs(result[0].nfDb! - expectedNF) < 1e-12);
  assert.equal(calculate(p, p.links[0]).nfDb, undefined);
});

test('V06: missing parameters and out-of-range RF never silently become zero; optical results survive missing RF reference', () => {
  const p = createExample();
  assert.equal(calculate(p, p.links[2], 6).rfGainDb, undefined);
  assert.match(calculate(p, p.links[2], 6).errors.join(), /超出 RF/);
  delete p.links[0].conversion;
  const partial = calculate(p, p.links[0]);
  assert.equal(partial.status, 'partial'); assert.equal(partial.rfGainDb, undefined); assert.equal(partial.opticalPowerDbm, -2);
  const table = p.components.find(c => c.id === 'mux')!.transfers[0].gainDb!;
  if (table.kind === 'channel') delete table.values.DWDM_CH28;
  assert.equal(calculate(p, p.links[0]).rfGainDb, undefined);
  assert.match(calculate(p, p.links[0]).errors.join(), /通道表不支持/);
  const invalid = { ...p.links[1], channelId: 'UNKNOWN' };
  assert.equal(calculate(p, invalid).status, 'error');
});

test('V05: unreachable and ambiguous routes reported; explicit constraint resolves ambiguity', () => {
  const p = createExample();
  p.connections.push({ id: 'bypass', from: endpoint('mux', 'line'), to: endpoint('demux', 'line'), gainDb: fixed(-2) });
  const link = { ...p.links[0], viaConnectionIds: [] };
  assert.equal(traceLink(p, link).status, 'ambiguous');
  assert.equal(traceLink(p, p.links[0]).status, 'ok');
  p.connections = p.connections.filter(c => c.id !== 'demux-pd28');
  assert.equal(traceLink(p, p.links[0]).status, 'unreachable');
});

test('A8/A9: JSON preserves entire project; layout edits do not change connections or the other view', () => {
  const p = createExample();
  const connections = structuredClone(p.connections), topology = structuredClone(p.layout.topology);
  p.layout.physical.pd28 = { x: 10.25, y: 20.75, rotation: 90 };
  p.instances.find(i => i.id === 'pd28')!.name = '接收器（重命名）';
  assert.deepEqual(p.connections, connections); assert.deepEqual(p.layout.topology, topology);
  const physical = structuredClone(p.layout.physical);
  p.layout.topology.pd28 = { x: 800.5, y: 250.2 };
  assert.deepEqual(p.layout.physical, physical);
  const restored = parseProject(serializeProject(p));
  assert.deepEqual(restored, p);
  assert.equal(calculate(restored, restored.links[0]).rfGainDb, -22);
});

test('channel grid and current-schema validation: CH28/CH30 are 200 GHz apart, CWDM uses standard centers', () => {
  const p = createExample();
  const a = CHANNELS.find(c => c.id === 'DWDM_CH28')!, b = CHANNELS.find(c => c.id === 'DWDM_CH30')!;
  assert.equal(a.frequencyTHz, 192.8); assert.equal(b.frequencyTHz, 193);
  assert.ok(Math.abs((b.frequencyTHz! - a.frequencyTHz!) * 1000 - 200) < 1e-9);
  assert.equal(CHANNELS.find(c => c.id === 'CWDM_1371')!.wavelengthNm, 1371);
  assert.equal(CHANNELS.filter(c => c.family === 'CWDM').length, 18);
  p.channels.find(c => c.id === 'DWDM_CH28')!.frequencyTHz = 192.9;
  assert.throws(() => parseProject(JSON.stringify(p)), /通道映射错误/);
  const illegal = createExample(); illegal.instances.find(i => i.id === 'tx28')!.overrides.arbitrary = fixed(1);
  assert.throws(() => serializeProject(illegal), /非法模块覆盖/);
  const curve = createExample(); curve.components.find(c => c.id === 'pcb')!.transfers[0].gainDb = { kind: 'rf', points: [[3, 1], [1, 2]] };
  assert.throws(() => serializeProject(curve), /严格递增/);
});
