import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import type { ModuleDefinition, Project } from '../../src/model/v1/types';
import { groupModule } from '../../src/state/v1/group-module';
import { editInstanceSettings } from '../../src/state/v1/instance-settings';
import { createProjectStore } from '../../src/state/v1/project-store';
import { moveInstance, planInstanceMove } from '../../src/state/v1/reparent-instance';
import { editModule } from '../../src/state/v1/topology-edits';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const sample = () => parseProjectJson(readFileSync(new URL('../../examples/v1-project.json', import.meta.url), 'utf8'));
const moduleById = (project: Project, id: string) => project.moduleDefinitions.find(module => module.id === id)!;
const roundTrip = (project: Project) => parseProjectJson(serializeProjectJson(project));
const fullLink = (project: Project) => project.namedLinks!.find(link => link.id === 'full')!;
const modulator = ['TX_A', 'mzm'];
const target = ['TX_A', 'mod'];
const nested = [...target, 'mzm'];

function addContainer(project: Project, owner: string): Project {
  const mod: ModuleDefinition = { id: 'mod-def', name: '调制模块', kind: 'module', ports: [], instances: [] };
  const withSlot = editModule(project, owner, module => ({
    ...module, instances: [...module.instances, { id: 'mod', name: mod.name, definitionId: mod.id }],
  }));
  return { ...withSlot, moduleDefinitions: [...withSlot.moduleDefinitions, mod] };
}

function withTrial(project: Project): Project {
  return { ...project, namedLinks: project.namedLinks?.map(link => link.id === 'full' ? {
    ...link, trial: { frequencyGHz: 1, inputPowerDbm: -20, opticalSources: [
      { endpoint: { instancePath: ['TX_A', 'laser'], portId: 'OUT' }, channelId: 'DWDM_CH28', powerDbm: 0 },
    ] },
  } : link) };
}

function assertBudget(project: Project, expected: ReturnType<ReturnType<typeof createLinkBudget>['calculateNamedLink']>) {
  const link = fullLink(project);
  const actual = createLinkBudget(project).calculateNamedLink(link, link.trial!);
  assert.equal(actual.kind, 'conversion');
  assert.deepEqual(actual.gainDb, expected.gainDb);
  assert.deepEqual(actual.powerDbm, expected.powerDbm);
}

test('moving down through a shared parent preserves each occurrence, named references, settings and the original budget', () => {
  const base = sample();
  const example = withTrial(addContainer({ ...base, componentDefinitions: base.componentDefinitions.map(definition =>
    definition.id !== 'mzm' ? definition : { ...definition, parameters: [...(definition.parameters ?? []), {
      id: 'biasProbe', name: '测试偏置', kind: 'numeric', unit: 'V', valueKind: 'fixed', overridable: true,
    }] }) }, 'tx'));
  const initial = editInstanceSettings(example, ['TX_B', 'mzm'], settings => ({
    ...settings, name: 'B 调制器', parameterOverrides: { biasProbe: { kind: 'fixed', value: 4 } },
  }));
  const link = fullLink(initial);
  const expectedBudget = createLinkBudget(initial).calculateNamedLink(link, link.trial!);
  const store = createProjectStore(initial);
  const before = store.getSnapshot();
  const preview = planInstanceMove(before.project, modulator, target, { position: { x: 420, y: 130 } });
  assert.ok(preview.ok, !preview.ok ? preview.message : undefined);
  assert.deepEqual(preview.instancePath, nested);
  assert.deepEqual(preview.affected, [
    { from: modulator, to: nested },
    { from: ['TX_B', 'mzm'], to: ['TX_B', 'mod', 'mzm'] },
  ]);
  assert.equal(store.getSnapshot(), before);
  assert.deepEqual(store.commit(draft => moveInstance(draft, modulator, target, { position: { x: 420, y: 130 } })), { ok: true });
  const moved = store.getSnapshot().project;
  assert.equal(store.resolveInstance(['TX_B', 'mod', 'mzm'])?.instance?.name, 'B 调制器');
  assert.deepEqual(store.resolveInstance(['TX_B', 'mod', 'mzm'])?.parameters.get('biasProbe')?.value, { kind: 'fixed', value: 4 });
  assert.deepEqual(store.resolveInstance(nested)?.parameters.get('operatingPointLoss')?.value, { kind: 'fixed', value: 2 });
  assert.deepEqual(fullLink(moved).conversionBindings?.[0].eo.instancePath, nested);
  assert.deepEqual(fullLink(moved).via, link.via);
  const tx = moduleById(moved, 'tx'), inner = moduleById(moved, 'mod-def');
  assert.deepEqual(tx.connections?.find(wire => wire.id === 'laser-feed')?.to, { instanceId: 'mod', portId: 'SUPPLY' });
  assert.deepEqual(inner.portMappings?.find(mapping => mapping.portId === 'SUPPLY')?.target, { instanceId: 'mzm', portId: 'SUPPLY' });
  assert.deepEqual(moved.layout?.topology?.at(-1), { instancePath: nested, x: 420, y: 130 });
  const oldPlacement = before.project.layout?.physical?.find(item => item.instancePath.join('/') === modulator.join('/'));
  assert.ok(oldPlacement);
  assert.deepEqual(moved.layout?.physical?.find(item => item.instancePath.join('/') === nested.join('/')),
    { ...oldPlacement, instancePath: nested });
  assertBudget(roundTrip(moved), expectedBudget);
  store.undo();
  assert.equal(store.getSnapshot().project, before.project);
  assert.equal(store.getSnapshot().canUndo, false);
  store.redo();
  assert.equal(store.getSnapshot().project, moved);

  const laser = moveInstance(moved, ['TX_A', 'laser'], target);
  assert.deepEqual(fullLink(laser).trial?.opticalSources?.[0].endpoint.instancePath, [...target, 'laser']);
  assertBudget(roundTrip(laser), expectedBudget);
  const observe: Project = { ...laser, namedLinks: [...(laser.namedLinks ?? []), {
    id: 'observe', name: '从模块光输出观察', from: { instancePath: target, portId: 'OUT' },
  }] };
  const raised = roundTrip(moveInstance(observe, nested, ['TX_A']));
  assert.deepEqual(raised.namedLinks?.find(item => item.id === 'observe')?.from, { instancePath: modulator, portId: 'OUT' });
  assert.deepEqual(fullLink(raised).conversionBindings?.[0].eo.instancePath, modulator);
  assert.deepEqual(moduleById(raised, 'tx').connections?.find(wire => wire.id === 'laser-feed')?.to,
    { instanceId: 'mzm', portId: 'SUPPLY' });
  assertBudget(raised, expectedBudget);

  const switchState = editInstanceSettings(raised, ['TX_B', 'optical-switch'], settings => ({ ...settings, switchStateId: 'block' }));
  const switched = createProjectStore(roundTrip(moveInstance(switchState, ['TX_A', 'optical-switch'], target)));
  assert.equal(switched.resolveInstance([...target, 'optical-switch'])?.switchState?.id, 'pass');
  assert.equal(switched.resolveInstance(['TX_B', 'mod', 'optical-switch'])?.switchState?.id, 'block');
});

test('moving up relocates internal wires and rewrites occurrence-local required wire references even when IDs collide', () => {
  const base = withTrial(sample());
  const grouped = groupModule(base, [['TX_A', 'laser'], modulator], '调制模块', 'mod', 'mod-def');
  const collision = editModule(grouped, 'tx', module => ({
    ...module, connections: module.connections?.map(wire => wire.id === 'dc-converted-feed' ? { ...wire, id: 'laser-feed' } : wire),
  }));
  const inside = [...target, 'laser'];
  const fixture: Project = { ...collision, namedLinks: [...(collision.namedLinks ?? []), {
    id: 'supply', name: '供光路径', from: { instancePath: inside, portId: 'OUT' },
    to: { instancePath: nested, portId: 'SUPPLY' }, via: [{ scopePath: target, connectionId: 'laser-feed' }],
  }] };
  const restored = roundTrip(moveInstance(fixture, nested, ['TX_A']));
  const required = restored.namedLinks!.find(link => link.id === 'supply')!;
  assert.deepEqual(required.to?.instancePath, modulator);
  assert.deepEqual(required.via, [{ scopePath: ['TX_A'], connectionId: 'laser-feed_2' }]);
  const parent = moduleById(restored, 'tx');
  assert.deepEqual(parent.connections?.find(wire => wire.id === 'laser-feed_2'), {
    id: 'laser-feed_2', from: { instanceId: 'mod', portId: 'OUT_2' },
    to: { instanceId: 'mzm', portId: 'SUPPLY' }, mediaKind: 'OPTICAL_FIBER',
  });
  assert.equal(createLinkBudget(restored).resolveNamedLink(required).status, 'resolved');
  const original = fullLink(fixture);
  assertBudget(restored, createLinkBudget(fixture).calculateNamedLink(original, original.trial!));
});

test('moving an enclosure remaps frame, descendant and enclosure paths while keeping physical placements and fibre identities', () => {
  const base = withTrial(addContainer(sample(), 'system'));
  const initial: Project = { ...base, layout: { ...base.layout, topologyFrames: [
    { modulePath: ['TX_A'], x: -20, y: -10, width: 560, height: 420 },
  ] } };
  const moved = roundTrip(moveInstance(initial, ['TX_A'], ['mod']));
  const placements = initial.layout!.physical!;
  assert.deepEqual(moved.layout?.physical, placements.map(item => ({
    ...item,
    instancePath: item.instancePath[0] === 'TX_A' ? ['mod', ...item.instancePath] : item.instancePath,
    enclosurePath: item.enclosurePath[0] === 'TX_A' ? ['mod', ...item.enclosurePath] : item.enclosurePath,
  })));
  assert.deepEqual(moved.layout?.topologyFrames, [{ ...initial.layout!.topologyFrames![0], modulePath: ['mod', 'TX_A'] }]);
  const oldLink = fullLink(initial);
  assert.deepEqual(fullLink(moved).via?.[0], { scopePath: ['mod', 'TX_A'], connectionId: 'rf-feed' });
  assert.deepEqual(fullLink(moved).via?.[1], { scopePath: [], bundleId: 'mpo-12', coreId: 'wdm' });
  assertBudget(moved, createLinkBudget(initial).calculateNamedLink(oldLink, oldLink.trial!));
  const raised = roundTrip(moveInstance(moved, ['mod', 'TX_A'], []));
  assert.deepEqual(raised.layout?.physical, placements);
  assert.deepEqual(raised.layout?.topologyFrames, initial.layout?.topologyFrames);
  assert.deepEqual(moduleById(raised, 'system').cableBundles, moduleById(initial, 'system').cableBundles);
});

test('an unsupported structural move reports its cause and leaves the snapshot and undo history intact', () => {
  const initial = addContainer(sample(), 'tx');
  const shared = editModule(initial, 'system', module => ({
    ...module, instances: [...module.instances, { id: 'mod-outside', name: '额外调制模块', definitionId: 'mod-def' }],
  }));
  const localCollision = editModule(initial, 'mod-def', module => ({
    ...module, instances: [{ id: 'mzm', name: '已有调制器', definitionId: 'mzm' }],
  }));
  const localParameter = editModule(moveInstance(initial, modulator, target), 'tx', module => ({
    ...module, parameterMappings: module.parameterMappings?.filter(mapping => mapping.target.instanceId !== 'mod'),
  }));
  const channelLimit = editModule(moveInstance(initial, modulator, target), 'mod-def', module => ({
    ...module, ports: module.ports.map(port => port.id === 'SUPPLY' ? { ...port, channelIds: ['DWDM_CH28'] } : port),
  }));
  const withBundle = editModule(moveInstance(initial, modulator, target), 'mod-def', module => ({
    ...module, cableBundles: [{ id: 'inside-mpo', coreCount: 1, cores: [
      { id: 'open', a: { pin: 1, endpoint: { instanceId: 'mzm', portId: 'OUT' } }, b: { pin: 1 } },
    ] }],
  }));
  const scenarios = [
    { project: shared, source: modulator, destination: target, reason: /另被.*额外调制模块/ },
    { project: localCollision, source: modulator, destination: target, reason: /已有实例 ID.*mzm/ },
    { project: initial, source: [], destination: target, reason: /根模块不能移动/ },
    { project: initial, source: ['TX_A'], destination: target, reason: /自身或其后代/ },
    { project: initial, source: modulator, destination: ['RX_A'], reason: /同层.*直接上一级/ },
    { project: localParameter, source: nested, destination: ['TX_A'], reason: /模块参数.*本层来源/ },
    { project: withBundle, source: nested, destination: ['TX_A'], reason: /线束.*inside-mpo/ },
    { project: channelLimit, source: nested, destination: ['TX_A'], reason: /对外端口.*SUPPLY.*光通道/ },
  ];
  for (const { project, source, destination, reason } of scenarios) {
    const store = createProjectStore(project);
    const before = store.getSnapshot();
    const result = planInstanceMove(before.project, source, destination);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, reason);
    assert.equal(store.commit(draft => moveInstance(draft, source, destination)).ok, false);
    assert.equal(store.getSnapshot(), before);
    assert.equal(before.canUndo, false);
  }
});
