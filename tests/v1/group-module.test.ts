import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import { buildSignalGraph, signalPortKey } from '../../src/engine/v1/signal-graph';
import type { Project } from '../../src/model/v1/types';
import { editInstanceSettings } from '../../src/state/v1/instance-settings';
import { groupModule } from '../../src/state/v1/group-module';
import { instantiateModule } from '../../src/state/v1/instantiate-module';
import { createProjectStore } from '../../src/state/v1/project-store';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const example = () => parseProjectJson(readFileSync(new URL('../../examples/v1-project.json', import.meta.url), 'utf8'));
const child = (id: string) => ['TX_A', id];

test('an entirely internal wire needs no public ports and keeps the other node in place', () => {
  const fixture: Project = {
    id: 'internal', name: '内部连线', rootModuleDefinitionId: 'root',
    componentDefinitions: [{ id: 'rf', name: '射频器件', kind: 'component', ports: [
      { id: 'IN', type: 'RF', direction: 'in' }, { id: 'OUT', type: 'RF', direction: 'out' },
    ] }],
    moduleDefinitions: [{
      id: 'root', name: '系统', kind: 'module', ports: [],
      instances: ['first', 'second', 'other'].map(id => ({ id, definitionId: 'rf', name: id })),
      connections: [{ id: 'inside', from: { instanceId: 'first', portId: 'OUT' }, to: { instanceId: 'second', portId: 'IN' } }],
    }],
  };
  const result = parseProjectJson(serializeProjectJson(groupModule(fixture, [['first'], ['second']], '内部组', 'group', 'group-def')));
  const [parent, group] = result.moduleDefinitions;
  assert.deepEqual(group.ports, []);
  assert.deepEqual(group.connections, fixture.moduleDefinitions[0].connections);
  assert.deepEqual(parent.connections, []);
  assert.deepEqual(result.layout?.topology?.find(item => item.instancePath[0] === 'other'),
    { instancePath: ['other'], x: 545, y: 25 });
});

test('grouping shared siblings moves internal wires and forwards boundary ports, parameters and layout atomically', () => {
  const initial = editInstanceSettings(example(), ['TX_B', 'optical-switch'], settings => ({ ...settings, name: 'B 开关' }));
  const store = createProjectStore(initial);
  const paths = ['laser', 'mzm', 'optical-switch'].map(child);
  const group = (project: typeof initial) => groupModule(project, paths, '发射模块', 'subtx', 'group-tx');
  assert.deepEqual(store.commit(group), { ok: true });
  const modified = store.getSnapshot().project;
  const parent = modified.moduleDefinitions.find(module => module.id === 'tx')!;
  const inner = modified.moduleDefinitions.find(module => module.id === 'group-tx')!;
  assert.deepEqual(inner.connections?.map(wire => wire.id), ['laser-feed', 'mzm-switch']);
  assert.deepEqual(parent.connections?.find(wire => wire.id === 'rf-feed')?.to, { instanceId: 'subtx', portId: 'RF_IN' });
  assert.deepEqual(inner.portMappings?.find(map => map.portId === 'RF_IN')?.target, { instanceId: 'mzm', portId: 'RF_IN' });
  assert.deepEqual(parent.portMappings?.find(map => map.portId === 'OPT_OUT')?.target, { instanceId: 'subtx', portId: 'OUT' });
  assert.deepEqual(inner.portMappings?.find(map => map.portId === 'OUT')?.target, { instanceId: 'optical-switch', portId: 'OUT' });
  assert.equal(inner.physicalEnclosure, undefined);
  const firstPlacement = initial.layout!.physical!.find(item => item.instancePath.join('/') === 'TX_A/mzm')!;
  assert.deepEqual(modified.layout!.physical!.find(item => item.instancePath.join('/') === 'TX_A/subtx/mzm'),
    { ...firstPlacement, instancePath: ['TX_A', 'subtx', 'mzm'] });
  assert.deepEqual(modified.layout!.topology!.find(item => item.instancePath.join('/') === 'TX_A/rf5'),
    { instancePath: ['TX_A', 'rf5'], x: 780, y: 265 });
  for (const tx of ['TX_A', 'TX_B']) {
    assert.equal(store.resolveInstance([tx, 'subtx', 'optical-switch'])?.instance?.switchStateId, 'pass');
    const mzm = store.resolveInstance([tx, 'subtx', 'mzm']);
    assert.deepEqual(mzm?.parameters.get('operatingPointLoss')?.value, { kind: 'fixed', value: 2 });
  }

  assert.equal(store.resolveInstance(['TX_B', 'subtx', 'optical-switch'])?.instance?.name, 'B 开关');
  assert.notEqual(store.resolveInstance(['TX_A', 'subtx', 'optical-switch'])?.instance?.name, 'B 开关');
  store.undo();
  assert.deepEqual(store.getSnapshot().project, initial);
  assert.equal(store.getSnapshot().canUndo, false);
  store.redo();
  assert.equal(store.getSnapshot().project, modified);
  assert.deepEqual(store.commit(project => instantiateModule(project, ['TX_A', 'subtx'], 'reuse', 'reuse', () => 'unused')), { ok: true });
  assert.equal(store.resolveInstance(['TX_B', 'reuse'])?.definition.id, 'group-tx');
  assert.deepEqual(store.commit(project => editInstanceSettings(project, ['TX_A', 'subtx', 'optical-switch'],
    settings => ({ ...settings, switchStateId: 'block' }))), { ok: true });
  for (const [tx, instance, state] of [['TX_A', 'subtx', 'block'], ['TX_B', 'subtx', 'pass'], ['TX_A', 'reuse', 'pass']]) {
    assert.equal(store.resolveInstance([tx, instance, 'optical-switch'])?.instance?.switchStateId, state);
  }
});

test('grouping scoped required wires, bindings and saved sources keeps the published budget through a JSON round trip', () => {
  const base = example();
  const trial = { frequencyGHz: 1, inputPowerDbm: -20, opticalSources: [
    { endpoint: { instancePath: child('laser'), portId: 'OUT' }, channelId: 'DWDM_CH28' as const, powerDbm: 0 },
  ] };
  const before = { ...base, namedLinks: base.namedLinks?.map(link => link.id === 'full' ? { ...link, trial } : link) };
  const paths = ['source', 'laser', 'mzm'].map(child);
  const restored = parseProjectJson(serializeProjectJson(groupModule(before, paths, '调制模块', 'inner', 'mod')));
  const link = restored.namedLinks!.find(item => item.id === 'full')!;
  assert.deepEqual(link.from?.instancePath, ['TX_A', 'inner', 'source']);
  assert.deepEqual(link.via?.[0], { scopePath: ['TX_A', 'inner'], connectionId: 'rf-feed' });
  assert.deepEqual(link.conversionBindings?.[0].eo.instancePath, ['TX_A', 'inner', 'mzm']);
  assert.deepEqual(link.trial?.opticalSources?.[0].endpoint.instancePath, ['TX_A', 'inner', 'laser']);
  const result = createLinkBudget(restored).calculateNamedLink(link, link.trial!);
  assert.equal(result.kind, 'conversion');
  assert.deepEqual(result.gainDb, { availability: 'available', value: -22, unit: 'dB' });
  assert.deepEqual(result.powerDbm, { availability: 'available', value: -42, unit: 'dBm' });
});

test('whole MPO cables can move, crossing ones retain core IDs, and mixed internal bundles reject without history', () => {
  const project = example();
  const round = (paths: string[][]) => parseProjectJson(serializeProjectJson(groupModule(project, paths, '成组', 'group', 'group-def')));
  const allInside = round([['TX_A'], ['RX_A']]);
  const scope = allInside.moduleDefinitions.find(module => module.id === 'group-def')!;
  assert.deepEqual(scope.cableBundles?.[0].cores.map(core => core.id), ['wdm', 'return', 'open']);
  assert.deepEqual(allInside.namedLinks?.find(link => link.id === 'full')?.via?.[1], { scopePath: ['group'], bundleId: 'mpo-12', coreId: 'wdm' });
  const embeddedPlacement = allInside.layout?.physical?.find(item => item.instancePath.join('/') === 'group/TX_A/mzm')!;
  assert.deepEqual(embeddedPlacement.enclosurePath, ['group', 'TX_A']);
  const through = round([['TX_A'], ['TX_B']]);
  const core = buildSignalGraph(through).edges.find(edge => edge.source.kind === 'cableCore' && edge.source.ref.coreId === 'wdm')!;
  const crossing = through.moduleDefinitions.find(module => module.id === 'group-def')!.portMappings
    ?.find(mapping => mapping.target.instanceId === 'TX_A' && mapping.target.portId === 'OPT_OUT');
  assert.ok(crossing);
  assert.equal(signalPortKey(core.from.ref), signalPortKey({ instancePath: ['group'], portId: crossing.portId }));
  assert.deepEqual(core.to.ref.instancePath, ['RX_A']);
  const mixed = { ...project, moduleDefinitions: project.moduleDefinitions.map(module => module.id !== 'system' ? module : {
    ...module, cableBundles: module.cableBundles?.map(bundle => ({ ...bundle, cores: [...bundle.cores, {
      id: 'other', a: { pin: 4, endpoint: { instanceId: 'TX_B', portId: 'TEST_OUT' } }, b: { pin: 9 },
    }] })),
  }) };
  const store = createProjectStore(mixed);
  const before = store.getSnapshot();
  assert.match((store.commit(draft => groupModule(draft, [['TX_A'], ['RX_A']], '成组', 'group', 'group-def')) as { message: string }).message,
    /mpo-12.*组内纤芯.*组外/);
  assert.match((store.commit(draft => groupModule(draft, [child('laser'), ['TX_B', 'laser']], '混合', 'group', 'group-def')) as { message: string }).message,
    /同一直接父模块/);
  assert.equal(store.getSnapshot(), before);
});
