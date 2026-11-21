import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkInputRating } from '../../src/engine/v1/budget-metric';
import type { BudgetMetric } from '../../src/engine/v1/budget-metric';
import { resolveEmpiricalValue } from '../../src/engine/v1/empirical-value';
import { createOpticalBudget } from '../../src/engine/v1/optical-budget';
import type { OpticalSource } from '../../src/engine/v1/optical-budget';
import { createPathResolver } from '../../src/engine/v1/path-resolver';
import { deviceExample } from '../../src/model/v1/device-example';
import { topologyExample } from '../../src/model/v1/topology-example';
import type { EndpointRef, ModuleDefinition, Project } from '../../src/model/v1/types';
import type { Transfer } from '../../src/model/v1/device';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const ch28 = 'DWDM_CH28', ch30 = 'DWDM_CH30';
const fixed = (value: number) => ({ kind: 'fixed' as const, value });
const ref = (instancePath: readonly string[], portId: string): EndpointRef => ({ instancePath, portId });
const local = (instanceId: string, portId: string) => ({ instanceId, portId });
const eo = (board: string) => ({ instancePath: [board, 'TX_CH30', 'mzm'], fromPortId: 'RF_IN', toPortId: 'OPT_OUT' });
const laser = (board: string, id = 'laser'): OpticalSource => ({
  endpoint: ref([board, 'TX_CH30', id], 'OUT'), channelId: ch30, powerDbm: 0,
});

function unavailableBecause(metric: BudgetMetric, expected: RegExp) {
  assert.equal(metric.availability, 'unavailable');
  assert.match(metric.reason, expected);
}

function fixture(): Project {
  const [{ instances }, board, tx, rx] = deviceExample.moduleDefinitions;
  const root: ModuleDefinition = {
    kind: 'module', id: 'system', name: 'System', ports: [],
    instances: [{ ...instances[0], parameterOverrides: { modulatorLoss: fixed(3) } }, ...instances.slice(1),
      { ...instances[0], id: 'boardB', parameterOverrides: { modulatorLoss: fixed(6) } },
      { id: 'converter', name: 'Converter', definitionId: 'converter' }],
    cableBundles: [{ id: 'mpo', coreCount: 12, cores: [{
      id: 'tx', a: { pin: 1, endpoint: local('board', 'TX_OUT') }, b: { pin: 12, endpoint: local('converter', 'IN') },
    }] }],
    connections: [{ id: 'switch', from: local('converter', 'OUT'), to: local('swB', 'IN') }],
  };
  return {
    ...deviceExample,
    componentDefinitions: [...deviceExample.componentDefinitions.map(component => component.id !== 'mzm' ? component : {
      ...component, ports: component.ports.map(port => port.id !== 'LASER_IN' ? port : {
        ...port, inputRating: { unit: 'dBm' as const, max: -1 },
      }),
    }), {
      kind: 'component', id: 'laser', name: 'Laser',
      ports: [{ id: 'OUT', type: 'OPTICAL', direction: 'out', channelIds: [ch28, ch30] }],
    }, {
      kind: 'component', id: 'converter', name: 'Channel converter',
      ports: [{ id: 'IN', type: 'OPTICAL', direction: 'in', channelIds: [ch30] },
        { id: 'OUT', type: 'OPTICAL', direction: 'out', channelIds: [ch28] }],
      transfers: [{ kind: 'wavelengthConversion', fromPortId: 'IN', toPortId: 'OUT', fromChannelId: ch30, toChannelId: ch28,
        gainDb: { kind: 'channelTable', values: { [ch30]: -2, [ch28]: -12 } } }],
    }],
    moduleDefinitions: [root, board, {
      ...tx,
      instances: [...tx.instances, { id: 'laser', name: 'Laser', definitionId: 'laser' },
        { id: 'backup', name: 'Backup', definitionId: 'laser' }],
      connections: ['laser', 'backup'].map(id => ({ id, from: local(id, 'OUT'), to: local('mzm', 'LASER_IN') })),
    }, rx],
  };
}

test('empirical values preserve zero, interpolate RF endpoints, and require exact optical channels', () => {
  const curve = { kind: 'rfCurve' as const, points: [[0, 0], [67, -2]] as const };
  assert.deepEqual(resolveEmpiricalValue('dB', fixed(0)), { unit: 'dB', availability: 'available', value: 0 });
  for (const [frequencyGHz, expected] of [[0, 0], [33.5, -1], [67, -2]]) {
    assert.deepEqual(resolveEmpiricalValue('dB', curve, { frequencyGHz }), { unit: 'dB', availability: 'available', value: expected });
  }
  unavailableBecause(resolveEmpiricalValue('dB', curve, { frequencyGHz: 68 }), /超出曲线范围/);
  unavailableBecause(resolveEmpiricalValue('dB', undefined), /未设置数值/);
  const table = { kind: 'channelTable' as const, values: { [ch30]: 0 } };
  unavailableBecause(resolveEmpiricalValue('dB', table, { channelId: ch28 }), /DWDM_CH28/);
  assert.deepEqual(resolveEmpiricalValue('dB', table, { channelId: ch30 }), { unit: 'dB', availability: 'available', value: 0 });
});

test('local EO budget traces separate supply, applies occurrence gain, and propagates through mappings, fibre and conversion', () => {
  const project = fixture();
  const { calculateLocal } = createOpticalBudget(project);
  const source = laser('board');
  const query = { eo: eo('board'), sources: [source], channelId: ch30 } as const;
  const moduleOut = ref(['board'], 'TX_OUT');
  const output = calculateLocal({ ...query, to: moduleOut });
  assert.equal(output.status, 'valid');
  assert.deepEqual(output.powerDbm, { unit: 'dBm', availability: 'available', value: -3 - q });
  assert.deepEqual(output.gainDb, { unit: 'dB', availability: 'available', value: -3 - q });
  assert.deepEqual(output.stages.map(({ endpoint }) => endpoint.portId), ['OUT', 'LASER_IN', 'OPT_OUT', 'OUT', 'TX_OUT']);
  assert.equal(output.stages[2].incoming?.edge.from.ref.portId, 'RF_IN');
  assert.deepEqual(output.stages[1].rating, {
    endpoint: ref(['board', 'TX_CH30', 'mzm'], 'LASER_IN'),
    limits: { unit: 'dBm', max: -1 }, status: 'above_max', value: 0, excess: 1,
  });
  assert.equal(createPathResolver(project).resolveLocalPath({ from: source.endpoint, to: moduleOut, channelId: ch30 }).status, 'unreachable');

  const remote = calculateLocal({ ...query, to: ref(['swB'], 'OUT_B') });
  assert.deepEqual(remote.powerDbm, { unit: 'dBm', availability: 'available', value: -3 - q - 2 - 1.2 });
  assert.deepEqual(remote.stages.slice(-4).map(({ channelId }) => channelId), [ch30, ch28, ch28, ch28]);
  assert.deepEqual(remote.stages.find(item => item.incoming?.edge.source.kind === 'cableCore')?.incoming?.gainDb,
    { unit: 'dB', availability: 'available', value: 0 });
  assert.equal(calculateLocal({ ...query, to: ref(['swB'], 'OUT_A') }).pathIssue?.status, 'unreachable');

  const second = calculateLocal({ eo: eo('boardB'), sources: [{ ...laser('boardB'), powerDbm: 2 }], channelId: ch30,
    to: ref(['boardB'], 'TX_OUT') });
  assert.deepEqual(second.gainDb, { unit: 'dB', availability: 'available', value: -6 - q });
  assert.deepEqual(second.powerDbm, { unit: 'dBm', availability: 'available', value: 2 + (-6 - q) });
  assert.equal(calculateLocal({ source, to: ref(eo('board').instancePath, 'LASER_IN') }).status, 'valid');
});

test('missing, mismatched and ambiguous supply remain unavailable while a supplied route with missing power keeps its gain', () => {
  const { calculateLocal } = createOpticalBudget(fixture());
  const source = laser('board');
  const query = { eo: eo('board'), channelId: ch30, to: ref(['board'], 'TX_OUT') } as const;
  for (const sources of [[], [{ ...source, channelId: ch28 }]] as const) {
    const result = calculateLocal({ ...query, sources });
    assert.equal(result.pathIssue?.status, 'missing_supply');
    assert.match(result.pathIssue!.reason, /兼容通道/);
    assert.equal(result.powerDbm.availability, 'unavailable');
  }
  const multi = calculateLocal({ ...query, sources: [source, laser('board', 'backup')] });
  assert.equal(multi.pathIssue?.status, 'ambiguous');
  assert.equal(multi.powerDbm.availability, 'unavailable');
  const result = calculateLocal({ ...query, sources: [{ ...source, powerDbm: undefined }] });
  assert.equal(result.status, 'partial');
  assert.equal(result.gainDb.availability, 'available');
  assert.equal(result.powerDbm.availability, 'unavailable');
  assert.equal(result.stages[1].rating?.status, 'unknown');
  assert.equal(checkInputRating(query.to, undefined, result.powerDbm), undefined);
});

test('an undeclared optical transfer gain does not become a lossless device', () => {
  const project = fixture();
  const componentDefinitions = project.componentDefinitions.map(definition => definition.id !== 'mzm' ? definition : {
    ...definition,
    transfers: definition.transfers?.map(transfer => transfer.kind !== 'eo' ? transfer : { ...transfer, insertionLossDb: undefined }),
  });
  const { calculateLocal } = createOpticalBudget({ ...project, componentDefinitions });
  const result = calculateLocal({ eo: eo('board'), sources: [laser('board')], channelId: ch30,
    to: ref(['board'], 'TX_OUT') });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.stages[1].powerDbm, { unit: 'dBm', availability: 'available', value: 0 });
  unavailableBecause(result.powerDbm, /未设置数值/);
  unavailableBecause(result.gainDb, /未设置数值/);
});

const q = 10 * Math.log10(2);
const splitTransfer = topologyExample.componentDefinitions.find(definition => definition.id === 'mzm')
  ?.transfers?.find(transfer => transfer.kind === 'eo')!;

function splitLossProject(transfer: Extract<Transfer, { kind: 'eo' }> = splitTransfer): Project {
  return {
    ...topologyExample,
    componentDefinitions: [
      ...topologyExample.componentDefinitions.map(definition => definition.id !== 'mzm' ? definition : {
        ...definition, transfers: [transfer],
      }),
      { kind: 'component', id: 'laser', name: 'Laser', ports: [{ id: 'OUT', type: 'OPTICAL', direction: 'out' }] },
    ],
    moduleDefinitions: topologyExample.moduleDefinitions.map(module => module.id !== 'tx' ? module : {
      ...module, instances: [...module.instances, { id: 'laser', name: 'Laser', definitionId: 'laser' }],
      connections: [...(module.connections ?? []), { id: 'supply', from: local('laser', 'OUT'), to: local('mzm', 'SUPPLY') }],
    }),
  };
}

function splitLossBudget(project: Project, tx: string, channelId: OpticalSource['channelId'] = ch28) {
  return createOpticalBudget(project).calculateLocal({
    eo: { instancePath: [tx, 'mzm'], fromPortId: 'RF_IN', toPortId: 'OUT' },
    sources: [{ endpoint: ref([tx, 'laser'], 'OUT'), channelId, powerDbm: 0 }],
    channelId, to: ref([tx], 'OPT_OUT'),
  });
}

test('each MZM loss is applied once and changing one transmitter insertion loss leaves its peer unchanged', () => {
  const project = splitLossProject();
  const before = splitLossBudget(project, 'TX_A');
  const after = parseProjectJson(serializeProjectJson({
    ...project,
    moduleDefinitions: project.moduleDefinitions.map(module => module.id !== 'system' ? module : {
      ...module, instances: module.instances.map(instance => instance.id !== 'TX_A' ? instance : {
        ...instance, parameterOverrides: { insertionLoss: fixed(0) },
      }),
    }),
  }));
  const a = splitLossBudget(after, 'TX_A');
  const b = splitLossBudget(after, 'TX_B');
  const loss = (result: ReturnType<typeof splitLossBudget>) => result.stages
    .find(step => step.endpoint.portId === 'OUT' && step.endpoint.instancePath.at(-1) === 'mzm')?.incoming?.opticalLoss;
  const db = (value: number) => ({ unit: 'dB', availability: 'available', value });
  assert.deepEqual(loss(before), { intrinsicLossDb: db(2), quadratureLossDb: db(q) });
  assert.deepEqual(loss(a), { intrinsicLossDb: db(0), quadratureLossDb: db(q) });
  assert.deepEqual(loss(b), loss(before));
  assert.deepEqual([before, a, b].map(result => result.powerDbm), [-2-q, -q, -2-q].map(value =>
    ({ unit: 'dBm', availability: 'available', value })));
  assert.deepEqual([before.gainDb, a.gainDb], [db(-2-q), db(-q)]);
});

test('MZM insertion loss rejects negative values and reports missing channel data', () => {
  for (const insertionLossDb of [undefined, { kind: 'channelTable', values: { [ch30]: 2 } }] as const) {
    const result = splitLossBudget(splitLossProject({ ...splitTransfer, insertionLossDb }), 'TX_A');
    unavailableBecause(result.powerDbm, /最大透过插损/);
    assert.equal(result.status, 'partial');
  }
  assert.throws(() => serializeProjectJson(splitLossProject({ ...splitTransfer, insertionLossDb: fixed(-3) })), /最大透过插损/);
});
