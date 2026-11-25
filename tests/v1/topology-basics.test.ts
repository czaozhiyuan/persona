import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveHierarchy } from '../../src/engine/v1/hierarchy';
import { wiringProblem } from '../../src/editors/topology/v1/wiring-validation';
import { blankComponentId, blankEnclosureId, blankModuleId, builtInDefinitions } from '../../src/library/v1/built-in';
import { insertLibraryItem } from '../../src/library/v1/insert-library-item';
import type { ModuleDefinition, PortDefinition, Project } from '../../src/model/v1/types';
import { createProjectStore } from '../../src/state/v1/project-store';
import { editModule } from '../../src/state/v1/topology-edits';
import { removeTopologyInstance, removeTopologyInstances, removeWiring } from '../../src/state/v1/remove-topology-object';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const root: ModuleDefinition = { id: 'system', name: '系统', kind: 'module', ports: [], instances: [] };
const empty: Project = { id: 'empty', name: '空工程', rootModuleDefinitionId: root.id, componentDefinitions: [], moduleDefinitions: [root] };
const example = parseProjectJson(readFileSync(new URL('../../examples/v1-project.json', import.meta.url), 'utf8'));

test('each built-in can be inserted from a blank project and blank containers receive independent definitions', () => {
  const template = (id: string, name: string) => ({ source: 'template' as const, id, name });
  const populated = builtInDefinitions.reduce((project, item, index) =>
    insertLibraryItem(project, template(item.id, item.name), root.id, [], 'item-' + index), empty);
  const first = insertLibraryItem(populated, template(blankModuleId, '发射'), root.id, [], 'tx', { x: 12, y: 34 });
  const second = insertLibraryItem(first, template(blankModuleId, '接收'), root.id, [], 'rx');
  const chassis = insertLibraryItem(second, template(blankEnclosureId, '机箱'), root.id, [], 'box');
  const restored = parseProjectJson(serializeProjectJson(chassis));
  const tree = resolveHierarchy(restored);
  assert.equal(tree.resolveInstance(['tx'])?.definition.name, '发射');
  assert.equal(tree.resolveInstance(['rx'])?.definition.name, '接收');
  assert.notEqual(tree.resolveInstance(['tx'])?.definition.id, tree.resolveInstance(['rx'])?.definition.id);
  const box = tree.resolveInstance(['box'])?.definition;
  assert.ok(box?.kind === 'module' && box.physicalEnclosure);
  assert.deepEqual(restored.layout?.topology, [{ instancePath: ['tx'], x: 12, y: 34 }]);
  const amplifier = tree.resolveInstance(['item-' + builtInDefinitions.findIndex(d => d.id === 'library-rf-amplifier')]);
  assert.deepEqual(amplifier?.parameters.get('gain')?.value, { kind: 'fixed', value: 5 });
  assert.deepEqual(amplifier?.parameters.get('nf')?.value, { kind: 'fixed', value: 3 });
});

test('blank devices are independent, empty and restored with their nested placement in one history entry', () => {
  const store = createProjectStore(empty);
  const container = { source: 'template', id: blankModuleId, name: '机内模块' } as const;
  const device = { source: 'template', id: blankComponentId, name: '待定义器件' } as const;
  assert.equal(store.commit(draft => insertLibraryItem(draft, container, root.id, [], 'module')).ok, true);
  const moduleId = store.resolveInstance(['module'])!.definition.id;
  assert.equal(store.commit(draft => insertLibraryItem(draft, device, moduleId, ['module'], 'first', { x: 105, y: 83 })).ok, true);
  const beforeSecond = store.getSnapshot().project;
  assert.equal(store.commit(draft => insertLibraryItem(draft, device, moduleId, ['module'], 'second', { x: 320, y: 83 })).ok, true);
  const first = store.resolveInstance(['module', 'first'])!.definition.id;
  const second = store.resolveInstance(['module', 'second'])!.definition.id;
  assert.notEqual(first, second);
  assert.deepEqual(store.resolveInstance(['module', 'first'])!.definition,
    { id: first, name: device.name, kind: 'component', ports: [] });
  store.undo();
  assert.deepEqual(store.getSnapshot().project, beforeSecond);
  assert.equal(store.resolveInstance(['module', 'second']), undefined);
  store.redo();
  const restored = parseProjectJson(serializeProjectJson(store.getSnapshot().project));
  assert.deepEqual(restored.layout?.topology, [
    { instancePath: ['module', 'first'], x: 105, y: 83 },
    { instancePath: ['module', 'second'], x: 320, y: 83 },
  ]);
  assert.deepEqual(restored.componentDefinitions.map(({ id, name, ports, transfers }) => ({ id, name, ports, transfers })), [
    { id: first, name: device.name, ports: [], transfers: undefined },
    { id: second, name: device.name, ports: [], transfers: undefined },
  ]);
});

test('wiring diagnostics distinguish directions, signal categories and duplicate connections', () => {
  const port = (id: string, type: PortDefinition['type'], direction: PortDefinition['direction']) =>
    ({ port: { id, type, direction }, direction, endpoint: { instanceId: id, portId: id } });
  const laser = port('laser', 'OPTICAL', 'out');
  const input = port('input', 'OPTICAL', 'in');
  const rf = port('rf', 'RF', 'in');
  assert.match(wiringProblem(root, laser, rf) ?? '', /光信号不能连接射频/);
  assert.match(wiringProblem(root, input, rf) ?? '', /两个端口都是输入/);
  assert.equal(wiringProblem(root, input, laser), undefined);
  assert.match(wiringProblem({ ...root, connections: [{ id: 'c', from: laser.endpoint, to: input.endpoint }] }, laser, input) ?? '', /已连接/);
});

const refA = { scopePath: ['TX_A'], connectionId: 'rf-feed' };
const refB = { scopePath: ['TX_B'], connectionId: 'rf-feed' };
const sameIdInRoot = { scopePath: [], connectionId: 'rf-feed' };
const otherWire = { scopePath: ['TX_A'], connectionId: 'rf-budget-in' };
const laserWire = { scopePath: ['TX_B'], connectionId: 'laser-feed' };
const mzmA = ['TX_A', 'mzm'];
const mzmB = ['TX_B', 'mzm'];

function linkFrom(project: Project, id: string) {
  const link = project.namedLinks?.find(item => item.id === id);
  assert.ok(link, id);
  return link;
}

function roundTrip(project: Project): Project {
  return parseProjectJson(serializeProjectJson(project));
}

function sharedWiringFixture(): Project {
  return {
    ...example,
    moduleDefinitions: example.moduleDefinitions.map(module => module.id !== root.id ? module : {
      ...module,
      connections: module.connections?.map(item => item.id === 'spare' ? { ...item, id: 'rf-feed' } : item),
    }),
    namedLinks: example.namedLinks?.map(link => {
      if (link.id === 'full') {
        assert.ok(link.via?.some(ref => 'connectionId' in ref
          && ref.connectionId === refA.connectionId && ref.scopePath.join('/') === 'TX_A'));
        return { ...link, via: [...link.via!, refB, sameIdInRoot, otherWire, laserWire] };
      }
      if (link.id === 'draft') return {
        ...link, from: { instancePath: mzmA, portId: 'OUT' },
        to: { instancePath: mzmB, portId: 'RF_IN' },
      };
      return link;
    }),
    layout: {
      ...example.layout,
      physical: [...(example.layout?.physical ?? []), {
        instancePath: mzmB, enclosurePath: ['TX_B'], xMm: 20, yMm: 40, rotationDeg: 0,
      }],
      topology: [...(example.layout?.topology ?? []),
        { instancePath: mzmA, x: 20, y: 40 }, { instancePath: mzmB, x: 25, y: 45 }],
    },
  };
}

test('deleting the required rf-feed wire clears both shared scopes and preserves an identical ID elsewhere', () => {
  const store = createProjectStore(sharedWiringFixture());
  const before = store.getSnapshot().project;
  const withoutCleanup = editModule(before, 'tx', module => ({
    ...module, connections: module.connections!.filter(item => item.id !== 'rf-feed'),
  }));
  assert.throws(() => serializeProjectJson(withoutCleanup), /不存在必经连接「rf-feed」/);

  assert.deepEqual(store.commit(draft => removeWiring(draft, 'tx', { kind: 'connection', id: 'rf-feed' })), { ok: true });
  const result = roundTrip(store.getSnapshot().project);
  assert.deepEqual(linkFrom(result, 'full').via, [
    { scopePath: [], bundleId: 'mpo-12', coreId: 'wdm' }, sameIdInRoot, otherWire, laserWire,
  ]);
  assert.ok(result.moduleDefinitions.find(item => item.id === root.id)?.connections?.some(item => item.id === 'rf-feed'));
  assert.ok(!result.moduleDefinitions.find(item => item.id === 'tx')?.connections?.some(item => item.id === 'rf-feed'));
  store.undo();
  assert.equal(store.getSnapshot().project, before);
  assert.equal(store.getSnapshot().canUndo, false);
});

test('a mixed batch cleans cable attachments, mappings and occurrence references in the saved project', () => {
  const base = sharedWiringFixture();
  const source = { endpoint: { instancePath: ['TX_A', 'laser'], portId: 'OUT' }, channelId: 'DWDM_CH28' } as const;
  const project = { ...base, instanceSettings: [{ instancePath: mzmB, name: 'Independent name' }],
    namedLinks: base.namedLinks?.map(link => link.id === 'full'
      ? { ...link, trial: { frequencyGHz: 2, opticalSources: [source] } } : link) };
  const store = createProjectStore(project);
  const initial = store.getSnapshot().project;
  const paths = [['TX_A'], mzmA, mzmB, ['TX_B', 'optical-switch']];
  assert.deepEqual(store.commit(draft => removeTopologyInstances(draft, paths).project), { ok: true });
  const saved = roundTrip(store.getSnapshot().project);
  const system = saved.moduleDefinitions.find(d => d.id === root.id)!;
  const tx = saved.moduleDefinitions.find(d => d.id === 'tx')!;
  assert.deepEqual(tx.ports, initial.moduleDefinitions.find(d => d.id === 'tx')!.ports);
  assert.deepEqual(tx.portMappings, []);
  assert.ok(tx.parameterMappings?.every(m => m.target.instanceId !== 'mzm'));
  assert.deepEqual(system.cableBundles?.[0].cores[0].a, { pin: 1 });
  assert.deepEqual(system.cableBundles?.[0].cores[0].b, { pin: 12, endpoint: { instanceId: 'RX_A', portId: 'OPT_IN' } });
  assert.deepEqual(linkFrom(saved, 'full').trial?.opticalSources, []);
  assert.ok(linkFrom(saved, 'full').via?.every(ref => ref.scopePath[0] !== 'TX_A'));
  assert.deepEqual([linkFrom(saved, 'draft').from, linkFrom(saved, 'draft').to], [undefined, undefined]);
  assert.deepEqual(saved.instanceSettings, []);
  assert.ok(saved.layout?.physical?.every(p => p.enclosurePath[0] !== 'TX_A' && p.instancePath[1] !== 'mzm'));
  assert.equal(saved.componentDefinitions.length, initial.componentDefinitions.length);
  store.undo();
  assert.equal(store.getSnapshot().project, initial);
});

test('deleting the shared modulator clears parent wires, scoped via, endpoints and placements as one edit', () => {
  const store = createProjectStore(sharedWiringFixture());
  const before = store.getSnapshot().project;
  assert.deepEqual(store.commit(draft => removeTopologyInstance(draft, 'tx', 'mzm')), { ok: true });

  const result = roundTrip(store.getSnapshot().project);
  const tx = result.moduleDefinitions.find(item => item.id === 'tx');
  assert.ok(tx);
  assert.ok(!tx.instances.some(item => item.id === 'mzm'));
  assert.ok(tx.connections?.every(item => item.from.instanceId !== 'mzm' && item.to.instanceId !== 'mzm'));
  assert.deepEqual(linkFrom(result, 'full').via, [
    { scopePath: [], bundleId: 'mpo-12', coreId: 'wdm' }, sameIdInRoot, otherWire,
  ]);
  assert.equal(linkFrom(result, 'draft').from, undefined);
  assert.equal(linkFrom(result, 'draft').to, undefined);
  const txModulator = (path: readonly string[]) => ['TX_A', 'TX_B'].includes(path[0]) && path[1] === 'mzm';
  assert.ok(!result.layout?.physical?.some(item => txModulator(item.instancePath)));
  assert.ok(!result.layout?.topology?.some(item => txModulator(item.instancePath)));

  store.undo();
  assert.equal(store.getSnapshot().project, before);
  assert.equal(store.getSnapshot().canUndo, false);
  store.redo();
  assert.deepEqual(roundTrip(store.getSnapshot().project), result);
});
