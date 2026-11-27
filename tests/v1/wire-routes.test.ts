import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Position } from '@xyflow/react';
import { curveThroughPoint } from '../../src/editors/topology/v1/signal-wire';
import { calculateDcBudget } from '../../src/engine/v1/dc-budget';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import type { Project, TopologyWireRoute, WireRef } from '../../src/model/v1/types';
import { planDissolveModule } from '../../src/state/v1/dissolve-module';
import { groupModule } from '../../src/state/v1/group-module';
import { pasteModule, pasteTopologyObjects } from '../../src/state/v1/instantiate-module';
import { connectBoundaryPort } from '../../src/state/v1/module-ports';
import { createProjectStore } from '../../src/state/v1/project-store';
import { removeTopologyInstance, removeWiring } from '../../src/state/v1/remove-topology-object';
import { moveInstance, planInstanceMoves } from '../../src/state/v1/reparent-instance';
import { planPortDeletion } from '../../src/state/v1/topology-edits';
import { applyWireRoutes, offsetRoute, setWireRoute, translateGroupRoutes } from '../../src/state/v1/wire-routes';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const example = parseProjectJson(readFileSync(new URL('../../examples/v1-project.json', import.meta.url), 'utf8'));
const rf: WireRef = { kind: 'connection', id: 'rf-feed' };
const mapping: WireRef = { kind: 'mapping', id: 'OPT_OUT' };
const core: WireRef = { kind: 'core', id: 'wdm', bundleId: 'mpo-12' };
const point = { x: -19.25, y: 320 };
const paths = (project: typeof example) => project.layout?.topologyWireRoutes?.map(r => [r.modulePath.join('/'), r.wire.id]);

test('two cubics pass through an outside waypoint with horizontal endpoint controls and a continuous tangent', () => {
  const edge = { sourceX: 10, sourceY: 25, targetX: 70, targetY: 35, sourcePosition: Position.Right, targetPosition: Position.Left };
  const [path, x, y] = curveThroughPoint(edge, point);
  assert.deepEqual([x, y], [point.x, point.y]);
  const numbers = path.match(/-?[\d.]+/g)!.map(Number);
  assert.deepEqual(numbers.slice(0, 2), [10, 25]);
  assert.ok(numbers[2] > 10 && numbers[3] === 25);
  assert.deepEqual(numbers.slice(6, 8), [x, y]);
  assert.match(path, / S /);
  assert.ok(numbers[8] < 70 && numbers[9] === 35);
  assert.deepEqual(numbers.slice(-2), [70, 35]);
});

test('a route through a waypoint follows the top and bottom handle tangents', () => {
  const edge = { sourceX: 10, sourceY: 25, targetX: 70, targetY: 35, sourcePosition: Position.Top, targetPosition: Position.Bottom };
  const [path] = curveThroughPoint(edge, point);
  const numbers = path.match(/-?[\d.]+/g)!.map(Number);
  assert.ok(numbers[2] === edge.sourceX && numbers[3] < edge.sourceY);
  assert.ok(numbers[8] === edge.targetX && numbers[9] > edge.targetY);
  assert.deepEqual(numbers.slice(6, 8), [point.x, point.y]);
});

test('a single moved device carries its self-loop waypoint while a wire to a stationary neighbour stays fixed', () => {
  const project: Project = { ...example, rootModuleDefinitionId: 'root', namedLinks: [], instanceSettings: [], layout: {},
    componentDefinitions: [{ id: 'dev', name: 'Device', kind: 'component', ports: [
      { id: 'out', type: 'RF', direction: 'out' }, { id: 'in', type: 'RF', direction: 'in' },
    ] }],
    moduleDefinitions: [{ id: 'root', name: 'Root', kind: 'module', ports: [],
      instances: ['a', 'b'].map(id => ({ id, name: id, definitionId: 'dev' })),
      connections: ['a', 'b'].map(id => ({ id, from: { instanceId: 'a', portId: 'out' }, to: { instanceId: id, portId: 'in' } })),
    }] };
  const self = setWireRoute(project, [], { kind: 'connection', id: 'a' }, point);
  const both = setWireRoute(self, [], { kind: 'connection', id: 'b' }, point);
  const moved = translateGroupRoutes(both, [['a']], { x: 33, y: 23 });
  assert.deepEqual(moved.layout!.topologyWireRoutes!.map(r => !r.kind && ({ x: r.x, y: r.y })), [{ x: point.x + 33, y: point.y + 23 }, point]);
});

test('orthogonal layout survives JSON and history, copies both anchors, and keeps manual and failed routes', () => {
  const points = [{ x: 40, y: 60 }, { x: 210, y: 60 }, { x: 210, y: 100 }];
  const manual = setWireRoute(example, ['TX_B'], rf, point);
  const updates: TopologyWireRoute[] = [
    { modulePath: [], wire: core, kind: 'orthogonal', points },
    { modulePath: ['TX_A'], wire: rf, kind: 'orthogonal', points },
    { modulePath: ['TX_A'], wire: mapping, kind: 'orthogonal', points },
  ];
  const planned = applyWireRoutes(manual, updates);
  assert.equal(applyWireRoutes(planned, structuredClone(updates)), planned);
  assert.equal(applyWireRoutes(planned, []), planned);
  assert.equal(planned.layout!.topologyWireRoutes![0], manual.layout!.topologyWireRoutes![0]);
  const store = createProjectStore(manual);
  assert.deepEqual(store.commit(p => applyWireRoutes(p, updates)), { ok: true });
  store.undo(); assert.deepEqual(store.getSnapshot().project, manual);
  store.redo(); assert.deepEqual(parseProjectJson(serializeProjectJson(store.getSnapshot().project)), planned);
  assert.deepEqual(calculateDcBudget(planned), calculateDcBudget(example));
  const link = example.namedLinks!.find(l => l.id === 'pure-rf')!;
  const conditions = { frequencyGHz: 10, inputPowerDbm: -20 };
  assert.deepEqual(createLinkBudget(planned).calculateNamedLink(link, conditions), createLinkBudget(example).calculateNamedLink(link, conditions));
  assert.throws(() => serializeProjectJson(applyWireRoutes(planned, [
    { ...updates[0], kind: 'orthogonal', points: [points[0], { x: 51, y: 77 }] },
  ])), /水平或垂直/);
  let id = 0;
  const roots = ['TX_A', 'RX_A'].map((slot, i) => ({ path: [slot], id: 'copy-' + i, routeOffset: { x: 300, y: -170 } }));
  const copy = parseProjectJson(serializeProjectJson(pasteTopologyObjects(planned, planned, roots, [], () => 'fresh-' + ++id)));
  const copied = copy.layout!.topologyWireRoutes!.filter(r => r.kind === 'orthogonal');
  assert.deepEqual(copied.filter(r => r.modulePath[0] === 'copy-0').map(r => r.points), [points, points]);
  assert.deepEqual(copied.find(r => r.wire.kind === 'core' && r.wire.bundleId !== 'mpo-12')?.points,
    points.map(p => ({ x: p.x + 300, y: p.y - 170 })));
  const unmoved = translateGroupRoutes(planned, [['TX_A'], ['RX_A']], { x: 43, y: 57 });
  assert.deepEqual(unmoved.layout!.topologyWireRoutes, planned.layout!.topologyWireRoutes);
  const reset = setWireRoute(planned, ['TX_A'], rf);
  assert.equal(reset.layout!.topologyWireRoutes!.length, 3);
  assert.ok(!removeWiring(planned, 'system', core).layout!.topologyWireRoutes!.some(r => r.wire.kind === 'core'));
  const relocation = planInstanceMoves(planned, [['TX_A'], ['RX_A']], ['deviceDemo']);
  assert.ok(relocation.ok);
  assert.equal(relocation.fixedRoutesToPlace.length, 1);
  assert.deepEqual(relocation.fixedRoutesToPlace[0].modulePath, ['deviceDemo']);
  const placed = applyWireRoutes(relocation.project, relocation.fixedRoutesToPlace.map(r => offsetRoute(r, { x: 85, y: -40 })));
  assert.ok(parseProjectJson(serializeProjectJson(placed)).layout!.topologyWireRoutes!.some(r =>
    r.kind === 'orthogonal' && r.wire.kind === 'core' && r.points[0].x === 125 && r.points[0].y === 20));
  assert.ok(!relocation.project.layout!.topologyWireRoutes!.some(r => r.wire.kind === 'core'));
  const regrouped = groupModule(planned, [['TX_A'], ['RX_A']], 'Group', 'group', 'group-def');
  assert.deepEqual(paths(parseProjectJson(serializeProjectJson(regrouped))),
    [['TX_B', 'rf-feed'], ['group/TX_A', 'rf-feed'], ['group/TX_A', 'OPT_OUT']]);
});

test('scoped project layout survives JSON and undo; rewiring, deletion and copy affect only the correct routes', () => {
  let project = setWireRoute(example, ['TX_A'], rf, point);
  project = setWireRoute(project, ['TX_B'], rf, { x: 23, y: -12 });
  project = setWireRoute(project, ['TX_A'], mapping, point);
  project = setWireRoute(project, [], core, point);
  const restored = parseProjectJson(serializeProjectJson(project));
  assert.deepEqual(restored.layout?.topologyWireRoutes, project.layout?.topologyWireRoutes);
  assert.deepEqual(calculateDcBudget(restored), calculateDcBudget(example));
  const link = example.namedLinks!.find(l => l.id === 'pure-rf')!;
  const conditions = { frequencyGHz: 10, inputPowerDbm: -20 };
  assert.deepEqual(createLinkBudget(restored).calculateNamedLink(link, conditions), createLinkBudget(example).calculateNamedLink(link, conditions));
  const store = createProjectStore(restored);
  const before = store.getSnapshot().project;
  assert.deepEqual(store.commit(p => removeWiring(p, 'system', core)), { ok: true });
  assert.equal(paths(store.getSnapshot().project)?.length, 3);
  store.undo(); assert.equal(store.getSnapshot().project, before);
  store.redo(); assert.equal(paths(store.getSnapshot().project)?.length, 3);
  assert.throws(() => serializeProjectJson(setWireRoute(removeWiring(restored, 'system', core), [], core, point)), /已连接/);
  assert.throws(() => serializeProjectJson(setWireRoute(restored, ['missing'], rf, point)), /已连接/);
  assert.throws(() => serializeProjectJson(setWireRoute(restored, [], core, { x: Infinity, y: 0 })), /有限数值/);
  const routes = restored.layout!.topologyWireRoutes!;
  assert.throws(() => serializeProjectJson({ ...restored, layout: { topologyWireRoutes: [...routes, routes[0]] } }), /重复/);
  const cleanup = (p: typeof example) => paths(parseProjectJson(serializeProjectJson(p)));
  assert.deepEqual(cleanup(removeTopologyInstance(restored, 'tx', 'source')), [['TX_A', 'OPT_OUT'], ['', 'wdm']]);
  assert.deepEqual(cleanup(planPortDeletion(restored, 'tx', 'OPT_OUT')!.project), [['TX_A', 'rf-feed'], ['TX_B', 'rf-feed']]);
  assert.deepEqual(cleanup(connectBoundaryPort(restored, 'tx', 'OPT_OUT', { instanceId: 'mzm', portId: 'OUT' })),
    [['TX_A', 'rf-feed'], ['TX_B', 'rf-feed'], ['', 'wdm']]);
  let n = 0;
  const copied = pasteModule(restored, restored, ['TX_A'], [], 'copy', () => 'copy-' + ++n);
  assert.deepEqual(cleanup(copied)?.slice(-2), [['copy', 'rf-feed'], ['copy', 'OPT_OUT']]);
  assert.deepEqual(setWireRoute(copied, ['copy'], rf, { x: 1, y: 2 }).layout!.topologyWireRoutes![0], routes[0]);
  const grouped = groupModule(restored, [['TX_A'], ['TX_B']], 'Pair', 'pair', 'pair-def');
  assert.deepEqual(cleanup(grouped), [['pair/TX_A', 'rf-feed'], ['pair/TX_B', 'rf-feed'], ['pair/TX_A', 'OPT_OUT']]);
  const dissolved = planDissolveModule(grouped, ['pair']);
  assert.ok(dissolved.ok);
  assert.deepEqual(cleanup(dissolved.project), [['TX_A', 'rf-feed'], ['TX_B', 'rf-feed'], ['TX_A', 'OPT_OUT']]);
  const moved = moveInstance(copied, ['copy', 'source'], []);
  assert.deepEqual(cleanup(moved), [...paths(restored)!, ['copy', 'OPT_OUT']]);
});
