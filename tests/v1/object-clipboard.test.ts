import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { projectTopology } from '../../src/editors/topology/v1/topology-projection';
import { captureTopologyObjects, pasteInView } from '../../src/editors/topology/v1/topology-layout-edits';
import { resolveHierarchy } from '../../src/engine/v1/hierarchy';
import type { InstancePath, Project, WireRef } from '../../src/model/v1/types';
import { createProjectStore } from '../../src/state/v1/project-store';
import { removeTopologyInstances } from '../../src/state/v1/remove-topology-object';
import { setWireRoute } from '../../src/state/v1/wire-routes';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const example = () => parseProjectJson(readFileSync(new URL('../../examples/v1-project.json', import.meta.url), 'utf8'));
const view = (p: Project, scope: InstancePath = []) => projectTopology(p, [...resolveHierarchy(p).walkInstances()],
  scope, new Set([JSON.stringify(['TX_A']), JSON.stringify(['TX_B'])]), new Map());
const unique = () => { let i = 0; return () => 'fresh-' + ++i; };
const rootModule = (p: Project) => p.moduleDefinitions.find(m => m.id === p.rootModuleDefinitionId)!;
const fixed = (value: number) => ({ kind: 'fixed', value }) as const;

test('copies only the outermost occurrences, their connected MPO cores, ordinary internal wires and translated routes', () => {
  const mpo: WireRef = { kind: 'core', bundleId: 'mpo-12', id: 'wdm' };
  const wire: WireRef = { kind: 'connection', id: 'spare' };
  let project = setWireRoute(example(), [], mpo, { x: 43, y: -17 });
  project = setWireRoute(project, [], wire, { x: 80, y: 77 });
  const store = createProjectStore(project);
  const initial = store.getSnapshot().project;
  const source = view(initial);
  const paths = [['TX_A', 'mzm'], ['TX_A'], ['RX_A'], ['TX_B'], ['RX_B']];
  const copied = captureTopologyObjects(initial, paths, source);
  assert.deepEqual(copied.objects.map(object => object.path), paths.slice(1));
  assert.throws(() => captureTopologyObjects(initial, [[], ['TX_A']], view(initial, ['TX_A'])), /选择/);
  assert.equal(store.getSnapshot().canUndo, false);
  const ids = ['a', 'b', 'c', 'd'];
  const dx = 430, dy = -620;
  const position = { x: copied.bounds.x + dx, y: copied.bounds.y + dy };
  assert.deepEqual(store.commit(p => pasteInView(p, copied, [], ids, position, source, unique())), { ok: true });
  const saved = parseProjectJson(serializeProjectJson(store.getSnapshot().project));
  const parent = rootModule(saved);
  const cable = parent.cableBundles!.at(-1)!;
  assert.notEqual(cable.id, 'mpo-12');
  assert.deepEqual(cable.cores.map(core => [core.id, core.a.endpoint!.instanceId, core.b.endpoint!.instanceId]),
    [['wdm', 'a', 'b'], ['return', 'a', 'b']]);
  assert.equal(cable.coreCount, 12);
  const wires = parent.connections!.slice(rootModule(initial).connections!.length);
  assert.deepEqual(wires.map(w => [w.from.instanceId, w.to.instanceId, w.mediaKind]),
    [['c', 'd', 'OPTICAL_FIBER'], ['c', 'd', 'RJ45_CABLE']]);
  const routes = saved.layout!.topologyWireRoutes!;
  assert.ok(routes.some(r => r.wire.kind === 'core' && r.wire.bundleId === cable.id && r.x === 43 + dx && r.y === -17 + dy));
  assert.ok(routes.some(r => r.wire.id === wires[0].id && r.x === 80 + dx && r.y === 77 + dy));
  assert.deepEqual(saved.namedLinks, initial.namedLinks);
  const resolver = resolveHierarchy(saved);
  assert.notEqual(resolver.resolveInstance(['a','mzm'])!.definition.id, resolver.resolveInstance(['c','mzm'])!.definition.id);
  store.undo();
  assert.equal(store.getSnapshot().project, initial);
  store.redo();
  assert.deepEqual(parseProjectJson(serializeProjectJson(store.getSnapshot().project)), saved);
  const removed = removeTopologyInstances(initial, [['TX_A','mzm'], ['TX_A']]).project;
  assert.ok(resolveHierarchy(removed).resolveInstance(['TX_B','mzm']));
});

test('copies a snapshot across visible parents and into a small frame, retaining mapped values, switch state, rails and group geometry', () => {
  const base = example();
  const supplyId = resolveHierarchy(base).resolveInstance(['TX_B','dc-supply'])!.definition.id;
  const project: Project = { ...base, instanceSettings: [
    { instancePath: ['TX_A'], parameterOverrides: { insertionLoss: fixed(9) } },
    { instancePath: ['TX_A','optical-switch'], switchStateId: 'block' },
  ], componentDefinitions: base.componentDefinitions.map(c => c.id !== supplyId ? c : {
    ...c, ports: [...c.ports, { id: 'rail2', type: 'DC_POWER', direction: 'out', outputVoltageV: fixed(12),
      supplyCapacity: { unit: 'A', value: fixed(0.7) } }],
  }), layout: { ...base.layout, topologyFrames: [{ modulePath: ['RX_A'], x: 65, y: 60, width: 340, height: 180 }] } };
  const original = setWireRoute(project, ['TX_A'], { kind: 'connection', id: 'mzm-switch' }, { x: 35, y: -63 });
  const store = createProjectStore(original);
  const snapshot = store.getSnapshot().project;
  const paths = [['TX_A','mzm'], ['TX_A','optical-switch'], ['TX_B','dc-supply']];
  const copied = captureTopologyObjects(snapshot, paths, view(snapshot));
  assert.equal(store.getSnapshot().canUndo, false);
  assert.deepEqual(store.commit(p => removeTopologyInstances(p, [['TX_A'], ['TX_B']]).project), { ok: true });
  const before = store.getSnapshot().project, destination = ['RX_A'];
  const targetView = view(before, destination);
  const oldDevice = targetView.scopes.get(JSON.stringify(destination))!.members[0].bounds;
  const position = { x: -700, y: -300 };
  const ids = ['mod','switch','supply'];
  assert.equal(store.commit(p => pasteInView(p, copied, destination, ['pd','bad','other'], position, targetView, unique())).ok, false);
  assert.equal(store.getSnapshot().project, before);
  assert.deepEqual(store.commit(p => pasteInView(p, copied, destination, ids, position, targetView, unique())), { ok: true });
  const saved = parseProjectJson(serializeProjectJson(store.getSnapshot().project));
  const hierarchy = resolveHierarchy(saved);
  const local = (id: string) => hierarchy.resolveInstance([...destination, id])!;
  assert.deepEqual(local('mod').parameters.get('insertionLoss'), { source: { kind: 'override' }, value: fixed(9) });
  assert.equal(local('switch').switchState!.id, 'block');
  assert.deepEqual(local('supply').definition.ports, snapshot.componentDefinitions.find(c => c.id === supplyId)!.ports);
  const receiver = hierarchy.resolveInstance(destination)!.definition;
  assert.ok(receiver.kind === 'module');
  assert.deepEqual(receiver.connections!.map(c => [c.from.instanceId,c.to.instanceId]), [['mod','switch']]);
  const txOrigin = copied.objects[0].parentOrigin;
  assert.deepEqual(saved.layout!.topologyWireRoutes!.find(r => r.wire.id === receiver.connections![0].id),
    { modulePath: destination, wire: { kind: 'connection', id: receiver.connections![0].id },
      x: 35 + txOrigin.x + position.x - copied.bounds.x, y: -63 + txOrigin.y + position.y - copied.bounds.y });
  const after = view(saved, destination);
  const members = after.scopes.get(JSON.stringify(destination))!.members;
  assert.deepEqual(members[0].bounds, oldDevice);
  for (const [index, object] of copied.objects.entries()) {
    const { x, y } = members[index + 1].bounds;
    assert.deepEqual({ x, y }, { x: position.x + object.bounds.x - copied.bounds.x, y: position.y + object.bounds.y - copied.bounds.y });
  }
  assert.ok(after.nodeByKey.get(after.rootKey)!.frame!.display.width > 340);
  assert.deepEqual(saved.namedLinks, parseProjectJson(serializeProjectJson(before)).namedLinks);
  store.undo();
  assert.equal(store.getSnapshot().project, before);
});
