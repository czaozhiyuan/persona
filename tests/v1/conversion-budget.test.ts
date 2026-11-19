import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversionBudget } from '../../src/engine/v1/conversion-budget';
import type { BudgetMetric } from '../../src/engine/v1/budget-metric';
import type { OpticalSource } from '../../src/engine/v1/optical-budget';
import type { Connection, ConversionBinding, NamedLink } from '../../src/model/v1/topology';
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

function fixture(twoSpans = false) {
  const components: ComponentDefinition[] = [
    { kind: 'component', id: 'amp', name: 'RF stage', ports: [rfIn, rfOut],
      transfers: [{ kind: 'rf', fromPortId: 'IN', toPortId: 'OUT', gainDb: fixed(5), nfDb: fixed(1) }] },
    { kind: 'component', id: 'laser', name: 'Laser', ports: [optOut] },
    { kind: 'component', id: 'eo', name: 'MZM', ports: [rfIn, { ...optIn, id: 'SUPPLY' }, optOut],
      transfers: [{ kind: 'eo', fromPortId: 'IN', toPortId: 'OUT', supplyPortId: 'SUPPLY',
        opticalLoss: { intrinsicLossDb: fixed(3), operatingPointLossDb: fixed(2) } }] },
    { kind: 'component', id: 'oe', name: 'PD', ports: [optIn, rfOut],
      transfers: [{ kind: 'oe', fromPortId: 'IN', toPortId: 'OUT' }] },
    { kind: 'component', id: 'attenuator', name: 'Optical attenuator', ports: [optIn, optOut],
      transfers: [{ kind: 'optical', fromPortId: 'IN', toPortId: 'OUT', gainDb: fixed(-3) }] },
  ];
  const instances: Instance[] = [];
  function add(id: string, definitionId: string) { instances.push({ id, name: id, definitionId }); }
  const connections: Connection[] = [];
  function connect(id: string, a: string, b: string, input = 'IN') {
    connections.push({ id, from: local(a, 'OUT'), to: local(b, input) });
  }
  add('pre', 'amp');
  add('post', 'amp');
  const bindings: ConversionBinding[] = [];
  for (const i of twoSpans ? [1, 2] : [1]) {
    add('laser' + i, 'laser');
    add('eo' + i, 'eo');
    add('oe' + i, 'oe');
    connect('supply' + i, 'laser' + i, 'eo' + i, 'SUPPLY');
    connect('light' + i, 'eo' + i, 'oe' + i);
    bindings.push({ id: 'span' + i, profileId: 'profile' + i,
      eo: { instancePath: ['eo' + i], fromPortId: 'IN', toPortId: 'OUT' },
      oe: { instancePath: ['oe' + i], fromPortId: 'IN', toPortId: 'OUT' } });
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
    conversionProfiles: [
      { id: 'profile1', name: 'First reference', rfGainRefDb: fixed(-22), pdPowerRefDbm: -5, applicability: { channelIds: [ch28] } },
      { id: 'profile2', name: 'Second reference', rfGainRefDb: fixed(-12), pdPowerRefDbm: -4, k: 3 },
    ],
  };
  const link: NamedLink = { id: 'link', name: 'Link', from: ref('pre', 'IN'), to: ref('post', 'OUT'), channelId: ch28,
    via: [{ scopePath: [], connectionId: 'light1' }], conversionBindings: bindings };
  return { project, link, bindings };
}

function numeric(metric: BudgetMetric) {
  assert.equal(metric.availability, 'available');
  return metric.value;
}

test('EO/OE calibration uses fixed reference, selected optical route and only the two external RF gains', () => {
  const { project, link } = fixture();
  const { calculateNamedLink } = createConversionBudget(project);
  for (const [laserPower, expectedGain] of [[-3, -28], [0, -22], [3, -16]]) {
    const result = calculateNamedLink(link, { frequencyGHz: 10, inputPowerDbm: -10, opticalSources: [source('laser1', laserPower)] });
    const [segment] = result.segments;
    assert.equal(result.status, 'partial');
    assert.equal(numeric(segment.pdPowerDbm), laserPower - 5);
    assert.equal(segment.reference?.pdPowerDbm, -5);
    assert.equal(segment.reference?.k, 2);
    assert.equal(numeric(segment.gainDb), expectedGain);
    assert.equal(numeric(result.gainDb), expectedGain + 10);
    assert.equal(numeric(result.powerDbm), expectedGain);
    assert.deepEqual(result.rfStages.map(stage => stage.input.instancePath[0]), ['pre', 'post']);
    assert.deepEqual(result.nfDb, { unit: 'dB', availability: 'unavailable', reason: '跨域链路未建模噪声系数。' });
    assert.deepEqual(result.diagnostics, []);
  }
  const alternate = calculateNamedLink({ ...link, via: [{ scopePath: [], connectionId: 'attenuated' }] },
    { frequencyGHz: 10, opticalSources: [source('laser1', 0)] });
  assert.equal(numeric(alternate.segments[0].pdPowerDbm), -8);
  assert.equal(numeric(alternate.segments[0].gainDb), -28);
  assert.equal(calculateNamedLink({ ...link, via: [] },
    { frequencyGHz: 10, opticalSources: [source('laser1', 0)] }).diagnostics[0].code, 'ambiguous');
  assert.equal(project.conversionProfiles![0].pdPowerRefDbm, -5);
});

test('binding overrides and profile channel validation preserve the actual PD power independently', () => {
  const { project, link, bindings } = fixture();
  const { calculateNamedLink } = createConversionBudget(project);
  const input = { frequencyGHz: 10, opticalSources: [source('laser1', 0)] };
  const overridden: NamedLink = { ...link, conversionBindings: [{ ...bindings[0], overrides: {
    k: 0, pdPowerRefDbm: 0, rfGainRefDb: { kind: 'rfCurve', points: [[0, -21], [20, -19]] },
  } }] };
  const result = calculateNamedLink(overridden, input);
  assert.equal(numeric(result.segments[0].gainDb), -20);
  assert.equal(result.segments[0].reference?.pdPowerDbm, 0);
  assert.equal(result.segments[0].reference?.k, 0);
  const outsideCurve = calculateNamedLink(overridden, { ...input, frequencyGHz: 67 });
  assert.equal(numeric(outsideCurve.segments[0].pdPowerDbm), -5);
  assert.equal(outsideCurve.gainDb.availability, 'unavailable');
  const wrongChannel = calculateNamedLink({ ...link, channelId: ch30 },
    { ...input, opticalSources: [{ ...source('laser1', 0), channelId: ch30 }] });
  assert.equal(numeric(wrongChannel.segments[0].pdPowerDbm), -5);
  assert.equal(wrongChannel.gainDb.availability, 'unavailable');
  assert.ok(wrongChannel.diagnostics.some(diagnostic => diagnostic.code === 'profile_channel'));
});

test('a wavelength converter selects the profile channel at the actual PD input', () => {
  const { project, link } = fixture();
  const converted: Project = {
    ...project,
    componentDefinitions: project.componentDefinitions.map(definition => definition.id !== 'attenuator' ? definition : {
      ...definition, transfers: [{ kind: 'wavelengthConversion', fromPortId: 'IN', toPortId: 'OUT',
        fromChannelId: ch28, toChannelId: ch30, gainDb: fixed(-3) }],
    }),
    conversionProfiles: project.conversionProfiles!.map(profile => profile.id !== 'profile1' ? profile : {
      ...profile, applicability: { channelIds: [ch30] },
    }),
  };
  const result = createConversionBudget(converted).calculateNamedLink({
    ...link, via: [{ scopePath: [], connectionId: 'attenuated' }],
  }, { frequencyGHz: 10, opticalSources: [source('laser1', 0)] });
  assert.equal(result.segments[0].channelId, ch30);
  assert.equal(numeric(result.segments[0].pdPowerDbm), -8);
  assert.equal(numeric(result.segments[0].gainDb), -28);
  assert.deepEqual(result.diagnostics, []);
});

test('serial conversion segments evaluate distinct supplies and bindings in path order', () => {
  const { project, link, bindings } = fixture(true);
  const { calculateNamedLink } = createConversionBudget(project);
  const input = { frequencyGHz: 18, opticalSources: [source('laser1', 0), { ...source('laser2', 2), channelId: ch30 }] } as const;
  const query = { ...link, channelId: undefined };
  const result = calculateNamedLink({ ...query, conversionBindings: [...bindings].reverse() }, input);
  assert.deepEqual(result.segments.map(segment => [segment.bindingId, segment.channelId, numeric(segment.pdPowerDbm), numeric(segment.gainDb)]),
    [['span1', ch28, -5, -22], ['span2', ch30, -3, -9]]);
  assert.deepEqual(result.rfStages.map(stage => stage.input.instancePath[0]), ['pre', 'middle', 'post']);
  assert.equal(numeric(result.gainDb), -16);
  const overlapping = calculateNamedLink({ ...query, conversionBindings: [
    { ...bindings[0], oe: bindings[1].oe }, { ...bindings[1], oe: bindings[0].oe },
  ] }, input);
  assert.equal(overlapping.gainDb.availability, 'unavailable');
  assert.equal(overlapping.diagnostics.filter(diagnostic => diagnostic.code === 'binding_mismatch').length, 2);
  assert.deepEqual(overlapping.segments.map(segment => numeric(segment.pdPowerDbm)), [-5, -3]);
});

test('missing link endpoints, calibration or optical supply never produce end-to-end gain', () => {
  const { project, link } = fixture();
  const { calculateNamedLink } = createConversionBudget(project);
  const input = { frequencyGHz: 18, opticalSources: [source('laser1', 0)] };
  const unbound = calculateNamedLink({ ...link, conversionBindings: [] }, input);
  assert.equal(numeric(unbound.segments[0].pdPowerDbm), -5);
  assert.equal(unbound.gainDb.availability, 'unavailable');
  assert.ok(unbound.diagnostics.some(diagnostic => diagnostic.code === 'missing_binding'));
  const mismatch = calculateNamedLink(link, { ...input, opticalSources: [{ ...source('laser1', 0), channelId: ch30 }] });
  assert.equal(mismatch.gainDb.availability, 'unavailable');
  assert.ok(mismatch.diagnostics.some(diagnostic => diagnostic.code === 'optical_supply'));
  const missingPower = calculateNamedLink(link, { ...input, opticalSources: [source('laser1')] });
  assert.equal(missingPower.gainDb.availability, 'unavailable');
  assert.ok(missingPower.segments[0].optical?.stages.length);
  const incomplete = calculateNamedLink({ ...link, to: undefined }, input);
  assert.equal(incomplete.gainDb.availability, 'unavailable');
  assert.equal(incomplete.diagnostics[0].code, 'incomplete');
});
