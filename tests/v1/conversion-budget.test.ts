import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversionBudget, loadedVoltages } from '../../src/engine/v1/conversion-budget';
import type { BudgetMetric } from '../../src/engine/v1/budget-metric';
import type { OpticalSource } from '../../src/engine/v1/optical-budget';
import type { Connection, NamedLink } from '../../src/model/v1/topology';
import type { ComponentDefinition, EndpointRef, Instance, PortDefinition, Project } from '../../src/model/v1/types';

const ch28 = 'DWDM_CH28', ch30 = 'DWDM_CH30';
const fixed = (value: number) => ({ kind: 'fixed' as const, value });
const ref = (id: string, portId: string): EndpointRef => ({ instancePath: [id], portId });
const local = (instanceId: string, portId: string) => ({ instanceId, portId });
const port = (id: string, type: PortDefinition['type'], direction: PortDefinition['direction']): PortDefinition =>
  ({ id, type, direction });
const rfIn = port('IN', 'RF', 'in'), rfOut = port('OUT', 'RF', 'out');
const optIn = port('IN', 'OPTICAL', 'in'), optOut = port('OUT', 'OPTICAL', 'out');
const source = (id: string, powerDbm?: number): OpticalSource => ({ endpoint: ref(id, 'OUT'), channelId: ch28, powerDbm });

type Receiver = Extract<NonNullable<ComponentDefinition['transfers']>[number], { kind: 'oe' }>;
type Modulator = Extract<NonNullable<ComponentDefinition['transfers']>[number], { kind: 'eo' }>;
function fixture(twoSpans = false, pd: Partial<Receiver> = {}, eo: Partial<Modulator> = {}) {
  const components: ComponentDefinition[] = [
    { kind: 'component', id: 'amp', name: 'RF stage', ports: [rfIn, rfOut],
      transfers: [{ kind: 'rf', fromPortId: 'IN', toPortId: 'OUT', gainDb: fixed(5), nfDb: fixed(1) }] },
    { kind: 'component', id: 'laser', name: 'Laser', ports: [{ ...optOut, opticalEmitter: { powerDbm: fixed(8.0102999566) } }] },
    { kind: 'component', id: 'eo', name: 'MZM', ports: [rfIn, { ...optIn, id: 'SUPPLY' }, optOut],
      transfers: [{ kind: 'eo', fromPortId: 'IN', toPortId: 'OUT', supplyPortId: 'SUPPLY',
        insertionLossDb: fixed(3), vPi: fixed(5), ...eo }] },
    { kind: 'component', id: 'oe', name: 'PD', ports: [optIn, rfOut],
      transfers: [{ kind: 'oe', fromPortId: 'IN', toPortId: 'OUT', receiver: 'external50', responsivity: fixed(0.8), ...pd }] },
    { kind: 'component', id: 'attenuator', name: 'Optical attenuator', ports: [optIn, optOut],
      transfers: [{ kind: 'optical', fromPortId: 'IN', toPortId: 'OUT', gainDb: fixed(-2) }] },
  ];
  const instances: Instance[] = [];
  function add(id: string, definitionId: string) { instances.push({ id, name: id, definitionId }); }
  const connections: Connection[] = [];
  function connect(id: string, a: string, b: string, input = 'IN') {
    connections.push({ id, from: local(a, 'OUT'), to: local(b, input) });
  }
  add('pre', 'amp');
  add('post', 'amp');
  for (const i of twoSpans ? [1, 2] : [1]) {
    add('laser' + i, 'laser');
    add('eo' + i, 'eo');
    add('oe' + i, 'oe');
    connect('supply' + i, 'laser' + i, 'eo' + i, 'SUPPLY');
    connect('light' + i, 'eo' + i, 'oe' + i);
  }
  add('atten', 'attenuator');
  connect('branch', 'eo1', 'atten');
  connect('attenuated', 'atten', 'oe1');
  connect('input', 'pre', 'eo1');
  if (twoSpans) {
    add('middle', 'amp');
    connect('middle-in', 'oe1', 'middle');
    connect('middle-out', 'middle', 'eo2');
  }
  connect('output', twoSpans ? 'oe2' : 'oe1', 'post');

  const project: Project = {
    id: 'conversion-test', name: 'Conversion test', rootModuleDefinitionId: 'system',
    componentDefinitions: components,
    moduleDefinitions: [{ kind: 'module', id: 'system', name: 'System', ports: [], instances, connections }],
  };
  const link: NamedLink = { id: 'link', name: 'Link', from: ref('pre', 'IN'), to: ref('post', 'OUT'), channelId: ch28,
    via: [{ scopePath: [], connectionId: 'attenuated' }] };
  return { project, link };
}

function numeric(metric: BudgetMetric) {
  assert.equal(metric.availability, 'available');
  return metric.value;
}

function near(actual: number, expected: number, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

test('quadrature modulation and three loaded receivers match independent numerical examples', () => {
  for (const [receiver, vppMv, rmsMv, expectedDbm] of [
    ['external50', 15.895341, 5.619852, -31.995203],
    ['parallel50', 7.947671, 2.809926, -38.015803],
    ['active50', 317.906825, 112.397036, -5.974603],
  ] as const) {
    const { project, link } = fixture(false, { receiver, loadedGain: fixed(800), responseDb: fixed(receiver === 'active50' ? -12 : 0) });
    const result = createConversionBudget(project).calculateNamedLink({ ...link, to: ref('oe1', 'OUT') }, { frequencyGHz: 2, inputPowerDbm: -5 });
    const [segment] = result.segments;
    near(numeric(segment.pdPowerDbm), 0);
    near(numeric(segment.averageCurrent), 0.0008, 1e-12);
    near(numeric(segment.modulationDepth), 0.1986917653, 1e-9);
    near(numeric(result.powerDbm), expectedDbm);
    const volts = loadedVoltages(result.powerDbm);
    near(numeric(volts.vpp) * 1000, vppMv);
    near(numeric(volts.vrms) * 1000, rmsMv);
    assert.equal(segment.extrapolated, false);
  }
});

test('optical loss, drive, Vπ, receiver response and downstream RF gains scale independently', () => {
  const evaluate = (pd: Partial<Receiver>, eo: Partial<Modulator>, drive = -5) => {
    const { project, link } = fixture(false, pd, eo);
    return createConversionBudget(project).calculateNamedLink(link, { frequencyGHz: 2, inputPowerDbm: drive });
  };
  const baseline = numeric(evaluate({}, {}).powerDbm);
  near(baseline, -31.995203 + 5);
  near(numeric(evaluate({}, { insertionLossDb: fixed(6) }).powerDbm), baseline - 6);
  near(numeric(evaluate({}, {}, -4).powerDbm), baseline + 1);
  near(numeric(evaluate({}, { vPi: fixed(10) }).powerDbm), baseline - 20 * Math.log10(2));
  near(numeric(evaluate({ responseDb: fixed(-3) }, {}).powerDbm), baseline - 3);
  assert.equal(evaluate({}, {}, 5).segments[0].extrapolated, true);
  const active = evaluate({ receiver: 'active50', responsivity: undefined, loadedGain: fixed(800) }, {});
  near(numeric(active.powerDbm), -5.974603 + 5);
  assert.equal(active.segments[0].averageCurrent.availability, 'unavailable');
});

test('Vπ interpolates in volts, preserves partial results at uncovered points and works without drive', () => {
  const { project, link } = fixture(false, {}, { vPi: { kind: 'rfCurve', points: [[1, 4], [3, 6]] } });
  const calc = createConversionBudget(project).calculateNamedLink;
  const relative = calc(link, { frequencyGHz: 2 });
  near(numeric(relative.gainDb), -31.995203 + 10);
  assert.equal(relative.powerDbm.availability, 'unavailable');
  assert.equal(relative.segments[0].modulationDepth.availability, 'unavailable');
  for (const frequencyGHz of [0, 4]) {
    const outside = calc(link, { frequencyGHz, inputPowerDbm: -5 });
    near(numeric(outside.segments[0].pdPowerDbm), 0);
    assert.equal(outside.gainDb.availability, 'unavailable');
    assert.match(outside.gainDb.reason, /RF Vπ.*曲线范围/);
  }
  assert.equal(calc({ ...link, via: [] }, { frequencyGHz: 2 }).diagnostics[0].code, 'ambiguous');
});

test('each cascaded span finds its own source and a trial override only affects its own branch', () => {
  const { project, link } = fixture(true);
  const calc = createConversionBudget(project).calculateNamedLink;
  const base = calc(link, { frequencyGHz: 2, inputPowerDbm: -5 });
  const [a, b] = base.segments;
  assert.equal(base.segments.length, 2);
  near(numeric(a.pdPowerDbm), 0);
  near(numeric(b.pdPowerDbm), 2);
  near(numeric(base.gainDb), numeric(a.gainDb) + numeric(b.gainDb) + 15);
  const changed = calc(link, { frequencyGHz: 2, opticalSources: [source('laser2', 5.0102999566)] });
  near(numeric(changed.gainDb), numeric(base.gainDb) - 6);
  near(numeric(changed.segments[0].pdPowerDbm), 0);
  assert.equal(base.nfDb.availability, 'unavailable');
});

test('CW at a receiver yields optical power and DC current without an electrical fundamental', () => {
  const { project } = fixture();
  const root = project.moduleDefinitions[0];
  const cw = { ...project, moduleDefinitions: [{ ...root, connections: [{ id: 'cw', from: local('laser1', 'OUT'), to: local('oe1', 'IN') }] }] };
  const calc = createConversionBudget(cw).calculateNamedLink;
  const link: NamedLink = { id: 'cw', name: 'CW', from: ref('laser1', 'OUT'), to: ref('oe1', 'OUT') };
  const selected = source('laser1');
  const channels: OpticalSource[] = [selected, { ...selected, channelId: ch30 }];
  for (const result of [
    calc({ ...link, channelId: ch28 }, { frequencyGHz: 2 }),
    calc(link, { frequencyGHz: 2, opticalSources: [selected] }),
    calc({ ...link, channelId: ch28 }, { frequencyGHz: 2, opticalSources: channels }),
  ]) {
    assert.ok(result.continuousWave);
    near(numeric(result.continuousWave.optical.powerDbm), 8.0102999566);
    near(numeric(result.continuousWave.averageCurrent), 0.005059644256, 1e-12);
    assert.equal(result.powerDbm.availability, 'unavailable');
    assert.match(result.powerDbm.reason, /连续光未携带射频调制/);
  }
  const ambiguous = calc(link, { frequencyGHz: 2, opticalSources: channels });
  assert.equal(ambiguous.continuousWave, undefined);
  assert.ok(ambiguous.diagnostics.some(item => item.code === 'optical_supply' && item.reason.includes('选择')));
  const conflict = calc({ ...link, channelId: ch30 }, { frequencyGHz: 2, opticalSources: [selected] });
  assert.equal(conflict.continuousWave, undefined);
});

test('known zero receiver response propagates zero power and loaded voltage through RF gain', () => {
  for (const pd of [
    { receiver: 'active50', loadedGain: fixed(0) },
    { receiver: 'active50', loadedGain: { kind: 'rfCurve', points: [[1, 800], [2, 0]] } },
    { receiver: 'external50', responsivity: fixed(0) },
  ] satisfies Partial<Receiver>[]) {
    const { project, link } = fixture(false, pd);
    const result = createConversionBudget(project).calculateNamedLink(link, { frequencyGHz: 2, inputPowerDbm: -5 });
    assert.equal(numeric(result.segments[0].gainDb), -Infinity);
    assert.equal(numeric(result.segments[0].rfOutputDbm), -Infinity);
    assert.equal(numeric(result.gainDb), -Infinity);
    assert.equal(numeric(result.powerDbm), -Infinity);
    const volts = loadedVoltages(result.powerDbm);
    assert.equal(numeric(volts.vrms), 0);
    assert.equal(numeric(volts.vpp), 0);
    assert.ok(!result.diagnostics.some(item => item.code === 'missing_gain'));
  }
});

test('two reachable emitters require selection and clearing the selection restores ambiguity', () => {
  const { project, link } = fixture();
  const root = project.moduleDefinitions[0];
  const second = { id: 'backup', name: 'Backup', definitionId: 'laser' };
  const calc = createConversionBudget({ ...project, moduleDefinitions: [{ ...root,
    instances: [...root.instances, second], connections: [...root.connections!, {
      id: 'second-feed', from: local('backup', 'OUT'), to: local('eo1', 'SUPPLY'),
    }],
  }] }).calculateNamedLink;
  assert.equal(calc(link, { frequencyGHz: 2 }).diagnostics[0].code, 'ambiguous');
  const selected = calc(link, { frequencyGHz: 2, opticalSources: [source('backup')] });
  near(numeric(selected.segments[0].pdPowerDbm), 0);
  assert.equal(calc(link, { frequencyGHz: 2, opticalSources: [] }).gainDb.availability, 'unavailable');
});

test('loaded receiver curve coverage governs RF only, including the low-frequency reference', () => {
  const { project, link } = fixture(false, { receiver: 'active50', loadedGain: { kind: 'rfCurve', points: [[1, 700], [3, 900]] } });
  const calc = createConversionBudget(project).calculateNamedLink;
  near(numeric(calc(link, { frequencyGHz: 2, inputPowerDbm: -5 }).powerDbm), -5.974603 + 5);
  const dc = calc(link, { frequencyGHz: 0 });
  assert.equal(dc.powerDbm.availability, 'unavailable');
  assert.equal(dc.gainDb.availability, 'unavailable');
  near(numeric(dc.segments[0].averageCurrent), 0.0008);
});

test('receiver uses the converted optical channel while emitter uses the original channel', () => {
  const { project, link } = fixture(false, { responsivity: { kind: 'channelTable', values: { [ch30]: 0.8 } } });
  const componentDefinitions: ComponentDefinition[] = project.componentDefinitions.map(component => {
    if (component.id === 'laser') return { ...component, ports: [{ ...optOut, opticalEmitter: {
      powerDbm: { kind: 'channelTable', values: { [ch28]: 8.0102999566 } },
    } }] };
    if (component.id !== 'attenuator') return component;
    return { ...component, transfers: [{ kind: 'wavelengthConversion', fromPortId: 'IN', toPortId: 'OUT',
      fromChannelId: ch28, toChannelId: ch30, gainDb: fixed(-2) }] };
  });
  const result = createConversionBudget({ ...project, componentDefinitions })
    .calculateNamedLink(link, { frequencyGHz: 2, inputPowerDbm: -5 });
  assert.equal(result.segments[0].channelId, ch30);
  near(numeric(result.segments[0].rfOutputDbm), -31.995203);
});
