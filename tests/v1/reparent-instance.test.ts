import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import type { ModuleDefinition, Project } from '../../src/model/v1/types';
import { editInstanceSettings } from '../../src/state/v1/instance-settings';
import { createProjectStore } from '../../src/state/v1/project-store';
import { moveInstance, moveInstances, planInstanceMove, planInstanceMoves } from '../../src/state/v1/reparent-instance';
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

test('a single move disconnects external wires and remaps each shared occurrence, settings and references', () => {
  const base = sample();
  const example = withTrial(addContainer({ ...base, componentDefinitions: base.componentDefinitions.map(definition =>
    definition.id !== 'mzm' ? definition : { ...definition, parameters: [...(definition.parameters ?? []), {
      id: 'biasProbe', name: '测试偏置', kind: 'numeric', unit: 'V', valueKind: 'fixed', overridable: true,
    }] }) }, 'tx'));
  const initial = editInstanceSettings(example, ['TX_B', 'mzm'], settings => ({
    ...settings, name: 'B 调制器', parameterOverrides: { biasProbe: { kind: 'fixed', value: 4 } },
  }));
  const link = fullLink(initial);
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
  assert.deepEqual(store.resolveInstance(nested)?.parameters.get('insertionLoss')?.value, { kind: 'fixed', value: 3 });
  assert.deepEqual(fullLink(moved).via, link.via?.filter(ref => !('connectionId' in ref)));
  const tx = moduleById(moved, 'tx'), inner = moduleById(moved, 'mod-def');
  assert.deepEqual(preview.wiring, { retained: 0, disconnected: 3 });
  assert.deepEqual(tx.connections, moduleById(initial, 'tx').connections?.filter(wire =>
    wire.from.instanceId !== 'mzm' && wire.to.instanceId !== 'mzm'));
  assert.deepEqual(inner.ports, []);
  assert.equal(inner.portMappings, undefined);
  assert.deepEqual(tx.ports, moduleById(initial, 'tx').ports);
  assert.equal(createLinkBudget(moved).resolveNamedLink(fullLink(moved)).status, 'unreachable');
  assert.deepEqual(moved.layout?.topology?.at(-1), { instancePath: nested, x: 420, y: 130 });
  const oldPlacement = before.project.layout?.physical?.find(item => item.instancePath.join('/') === modulator.join('/'));
  assert.ok(oldPlacement);
  assert.deepEqual(moved.layout?.physical?.find(item => item.instancePath.join('/') === nested.join('/')),
    { ...oldPlacement, instancePath: nested });
  assert.deepEqual(roundTrip(moved), roundTrip(preview.project));
  store.undo();
  assert.equal(store.getSnapshot().project, before.project);
  assert.equal(store.getSnapshot().canUndo, false);
  store.redo();
  assert.equal(store.getSnapshot().project, moved);

  const raised = roundTrip(moveInstance(moved, nested, ['TX_A']));
  assert.equal(moduleById(raised, 'tx').connections?.some(wire => wire.id === 'laser-feed'), false);
  assert.deepEqual(createProjectStore(raised).resolveInstance(modulator)?.parameters.get('insertionLoss')?.value, { kind: 'fixed', value: 3 });

  const switchState = editInstanceSettings(raised, ['TX_B', 'optical-switch'], settings => ({ ...settings, switchStateId: 'block' }));
  const switched = createProjectStore(roundTrip(moveInstance(switchState, ['TX_A', 'optical-switch'], target)));
  assert.equal(switched.resolveInstance([...target, 'optical-switch'])?.switchState?.id, 'pass');
  assert.equal(switched.resolveInstance(['TX_B', 'mod', 'optical-switch'])?.switchState?.id, 'block');
  assert.deepEqual(moduleById(switched.getSnapshot().project, 'tx').portMappings, []);
  assert.deepEqual(moduleById(switched.getSnapshot().project, 'tx').ports, moduleById(initial, 'tx').ports);
});

test('batch move down and up relocates internal wires and refs, disconnects crossing wires, and commits once', () => {
  const base = withTrial(addContainer(sample(), 'tx'));
  const laser = ['TX_A', 'laser'];
  const fixture: Project = { ...base, namedLinks: [...(base.namedLinks ?? []), {
    id: 'supply', name: '供光路径', from: { instancePath: laser, portId: 'OUT' },
    to: { instancePath: modulator, portId: 'SUPPLY' }, via: [{ scopePath: ['TX_A'], connectionId: 'laser-feed' }],
  }] };
  const supply = (project: Project) => project.namedLinks!.find(link => link.id === 'supply')!;
  const store = createProjectStore(fixture);
  const before = store.getSnapshot().project;
  const sources = [laser, modulator];
  const plan = planInstanceMoves(before, sources, target);
  assert.ok(plan.ok, !plan.ok ? plan.message : undefined);
  assert.deepEqual(plan.instancePaths, [[...target, 'laser'], nested]);
  assert.deepEqual(plan.wiring, { retained: 1, disconnected: 2 });
  assert.equal(plan.affected.length, 4);
  assert.equal(store.getSnapshot().project, before);
  assert.deepEqual(store.commit(draft => moveInstances(draft, sources, target)), { ok: true });
  const moved = roundTrip(store.getSnapshot().project);
  assert.deepEqual(moduleById(moved, 'tx').connections, moduleById(fixture, 'tx').connections?.filter(wire =>
    !['laser-feed', 'rf-feed', 'mzm-switch'].includes(wire.id)));
  assert.deepEqual(moduleById(moved, 'mod-def').connections, moduleById(fixture, 'tx').connections?.filter(wire => wire.id === 'laser-feed'));
  assert.deepEqual(moduleById(moved, 'mod-def').ports, []);
  assert.deepEqual(supply(moved).via, [{ scopePath: target, connectionId: 'laser-feed' }]);
  assert.deepEqual(fullLink(moved).trial?.opticalSources?.[0].endpoint.instancePath, [...target, 'laser']);
  assert.deepEqual(moved.namedLinks?.find(link => link.id === 'pure-rf'), fixture.namedLinks?.find(link => link.id === 'pure-rf'));
  assert.equal(createLinkBudget(moved).resolveNamedLink(supply(moved)).status, 'resolved');
  store.undo();
  assert.equal(store.getSnapshot().project, before);
  assert.equal(store.getSnapshot().canUndo, false);
  store.redo();
  assert.deepEqual(roundTrip(store.getSnapshot().project), moved);

  const collision = editModule(moved, 'tx', module => ({
    ...module, connections: module.connections?.map(wire => wire.id === 'dc-converted-feed' ? { ...wire, id: 'laser-feed' } : wire),
  }));
  const raised = roundTrip(moveInstances(collision, plan.instancePaths, ['TX_A']));
  assert.deepEqual(supply(raised).via, [{ scopePath: ['TX_A'], connectionId: 'laser-feed_2' }]);
  assert.deepEqual(supply(raised).to?.instancePath, modulator);
  assert.equal(createLinkBudget(raised).resolveNamedLink(supply(raised)).status, 'resolved');
});

test('moving out drops a mapped boundary association while keeping the port and external wire terminating there', () => {
  const base = addContainer(sample(), 'tx');
  const inside = moveInstance(base, modulator, target);
  const exposed = editModule(inside, 'mod-def', module => ({
    ...module, ports: [{ id: 'OLD_IN', direction: 'in', type: 'RF', inputRating: { unit: 'dBm', max: 5 } }],
    portMappings: [{ portId: 'OLD_IN', target: { instanceId: 'mzm', portId: 'RF_IN' } }],
  }));
  const fixture = editModule(exposed, 'tx', module => ({
    ...module, connections: [...(module.connections ?? []), {
      id: 'to-boundary', from: { instanceId: 'source', portId: 'OUT' }, to: { instanceId: 'mod', portId: 'OLD_IN' },
    }],
  }));
  const raised = roundTrip(moveInstance(fixture, nested, ['TX_A']));
  assert.deepEqual(moduleById(raised, 'mod-def').ports, moduleById(fixture, 'mod-def').ports);
  assert.deepEqual(moduleById(raised, 'mod-def').portMappings, []);
  assert.deepEqual(moduleById(raised, 'tx').connections, moduleById(fixture, 'tx').connections);
  assert.equal(createLinkBudget(raised).resolveNamedLink(fullLink(raised)).status, 'unreachable');
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
  assert.deepEqual(fullLink(moved).via, [{ scopePath: ['mod', 'TX_A'], connectionId: 'rf-feed' }]);
  const system = moduleById(moved, 'system');
  const oldBundle = moduleById(initial, 'system').cableBundles![0];
  assert.deepEqual(system.cableBundles?.[0], { ...oldBundle, cores: oldBundle.cores.map(core => ({
    ...core, a: { pin: core.a.pin },
  })) });
  const raised = roundTrip(moveInstance(moved, ['mod', 'TX_A'], []));
  assert.deepEqual(raised.layout?.physical, placements);
  assert.deepEqual(raised.layout?.topologyFrames, initial.layout?.topologyFrames);
  assert.deepEqual(moduleById(raised, 'system').cableBundles, system.cableBundles);
});

test('a complete mobile bundle keeps pins, attachments and scoped required cores', () => {
  const initial = withTrial(addContainer(sample(), 'system'));
  const sources = [['TX_A'], ['RX_A']];
  const plan = planInstanceMoves(initial, sources, ['mod']);
  assert.ok(plan.ok, !plan.ok ? plan.message : undefined);
  assert.deepEqual(plan.wiring, { retained: 2, disconnected: 0 });
  const moved = roundTrip(plan.project);
  assert.deepEqual(moduleById(moved, 'mod-def').cableBundles, moduleById(initial, 'system').cableBundles);
  assert.deepEqual(moduleById(moved, 'system').cableBundles, []);
  assert.deepEqual(fullLink(moved).via, [
    { scopePath: ['mod', 'TX_A'], connectionId: 'rf-feed' },
    { scopePath: ['mod'], bundleId: 'mpo-12', coreId: 'wdm' },
  ]);
  const original = createLinkBudget(initial).calculateNamedLink(fullLink(initial), fullLink(initial).trial!);
  const relocated = createLinkBudget(moved).calculateNamedLink(fullLink(moved), fullLink(moved).trial!);
  assert.equal(relocated.kind, 'conversion');
  assert.deepEqual(relocated.powerDbm, original.powerDbm);
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
  const mixed = editModule(addContainer(sample(), 'system'), 'system', module => ({
    ...module, cableBundles: module.cableBundles?.map(bundle => ({ ...bundle, cores: [...bundle.cores, {
      id: 'fixed', a: { pin: 4, endpoint: { instanceId: 'TX_B', portId: 'TEST_OUT' } }, b: { pin: 9 },
    }] })),
  }));
  const scenarios = [
    { project: shared, source: modulator, destination: target, reason: /另被.*额外调制模块/ },
    { project: localCollision, source: modulator, destination: target, reason: /已有实例「已有调制器」.*内部引用冲突/ },
    { project: initial, source: [], destination: target, reason: /根模块不能移动/ },
    { project: initial, source: ['TX_A'], destination: target, reason: /自身或其后代/ },
    { project: initial, source: modulator, destination: ['RX_A'], reason: /模块定义「发射机箱」另被.*发射机箱 B/ },
    { project: localParameter, source: nested, destination: ['TX_A'], reason: /模块参数.*本层来源/ },
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

  const preview = planInstanceMoves(mixed, [['TX_A'], ['RX_A']], ['mod']);
  assert.ok(!preview.ok);
  assert.match(preview.message, /纤芯（A:1 \/ B:12）.*无法安全拆分/);
  const store = createProjectStore(mixed);
  const before = store.getSnapshot();
  assert.equal(store.commit(draft => moveInstances(draft, [['TX_A'], ['RX_A']], ['mod'])).ok, false);
  assert.equal(store.getSnapshot(), before);
  assert.equal(planInstanceMoves(initial, [modulator, ['TX_B', 'laser']], target).ok, false);
  assert.equal(planInstanceMoves(initial, [modulator, modulator], target).ok, false);
});

test('multi-level and cross-branch moves transfer only the selected wiring and preserve each occurrence', () => {
  const base = addContainer(sample(), 'tx');
  const slots = ['left', 'right'].map(id => ({ id, definitionId: id, name: id }));
  const withSlots = editModule(base, 'mod-def', module => ({ ...module, instances: slots }));
  const fixture: Project = { ...withSlots, moduleDefinitions: [...withSlots.moduleDefinitions,
    ...slots.map(({ id, name }): ModuleDefinition => ({ kind: 'module', id, name, ports: [], instances: [] }))] };
  const store = createProjectStore(fixture);
  const sources = [modulator, ['TX_A', 'laser']];
  const initial = store.getSnapshot().project;
  const left = [...target, 'left'], right = [...target, 'right'];
  let objects = sources;
  for (const [step, destination] of [left, right, ['TX_A']].entries()) {
    const before = store.getSnapshot().project;
    const plan = planInstanceMoves(before, objects, destination);
    assert.ok(plan.ok, !plan.ok ? plan.message : undefined);
    assert.deepEqual(plan.wiring, { retained: 1, disconnected: step ? 0 : 2 });
    assert.equal(store.commit(() => plan.project).ok, true);
    const moved = store.getSnapshot().project;
    const owner = store.resolveInstance(destination)?.definition;
    assert.ok(owner?.kind === 'module');
    assert.ok(owner.connections?.some(wire => wire.id === 'laser-feed'));
    for (const branch of ['TX_A', 'TX_B']) {
      const path = [branch, ...destination.slice(1), 'mzm'];
      assert.deepEqual(store.resolveInstance(path)?.parameters.get('insertionLoss')?.value,
        createProjectStore(initial).resolveInstance([branch, 'mzm'])?.parameters.get('insertionLoss')?.value);
      const original = initial.layout?.physical?.find(item => item.instancePath.join('/') === [branch, 'mzm'].join('/'));
      assert.deepEqual(moved.layout?.physical?.find(item => item.instancePath.join('/') === path.join('/')),
        original && { ...original, instancePath: path });
    }
    assert.deepEqual(roundTrip(moved), roundTrip(plan.project));
    store.undo();
    assert.equal(store.getSnapshot().project, before);
    store.redo();
    objects = plan.instancePaths.map(path => [...path]);
  }
});
