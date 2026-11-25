import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveHierarchy } from '../../src/engine/v1/hierarchy';
import { buildSignalGraph } from '../../src/engine/v1/signal-graph';
import { mappingId, type ModuleDefinition, type Project } from '../../src/model/v1/types';
import { planDissolveModule } from '../../src/state/v1/dissolve-module';
import { groupModule } from '../../src/state/v1/group-module';
import { pasteModule } from '../../src/state/v1/instantiate-module';
import { connectBoundaryPort } from '../../src/state/v1/module-ports';
import { createProjectStore } from '../../src/state/v1/project-store';
import { removeWiring } from '../../src/state/v1/remove-topology-object';
import { planInstanceMove } from '../../src/state/v1/reparent-instance';
import { editModule, editModuleWiring, planPortDeletion } from '../../src/state/v1/topology-edits';
import { setWireRoute } from '../../src/state/v1/wire-routes';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const port = { id: 'P', type: 'AC_POWER', direction: 'in' } as const;
const slot = (id: string, definitionId = id) => ({ id, definitionId, name: id });
const target = (instanceId: string) => ({ instanceId, portId: port.id });
const base: Project = {
  id: 'test', name: '供电支路', rootModuleDefinitionId: 'root',
  componentDefinitions: [{ kind: 'component', id: 'load', name: '负载', ports: [port] }],
  moduleDefinitions: [
    { kind: 'module', id: 'root', name: '系统', ports: [port], instances: [slot('left', 'box'), slot('right', 'box')],
      portMappings: [{ portId: 'P', target: target('left') }] },
    { kind: 'module', id: 'box', name: '机箱', ports: [port], instances: ['A', 'B', 'C'].map(id => slot(id, 'load')),
      portMappings: [{ portId: 'P', target: target('A') }] },
  ],
};
const round = (p: Project) => parseProjectJson(serializeProjectJson(p));
const box = (p: Project) => p.moduleDefinitions.find(m => m.id === 'box')!;
const branches = (m: ModuleDefinition) => m.portMappings!.map(mapping => [mappingId(mapping), mapping.target.instanceId]);
const fan = () => connectBoundaryPort(connectBoundaryPort(base, 'box', 'P', target('B')), 'box', 'P', target('C'));

test('shared fanout wires keep distinct references through JSON, single-wire removal, history and independent copies', () => {
  const wired = fan();
  const ids = box(wired).portMappings!.map(mappingId);
  assert.equal(new Set(ids).size, 3);
  const graph = buildSignalGraph(wired);
  const sources = graph.edges.map(edge => edge.source).filter(source => source.kind === 'portMapping');
  for (const path of ['left', 'right']) {
    assert.deepEqual(sources.filter(s => s.publicPort.instancePath[0] === path).map(s => s.mappingId), ids);
  }
  const routed = ids.reduce((p, id, index) => setWireRoute(p, ['left'], { kind: 'mapping', id }, { x: 45, y: 20 + index }), wired);
  const reattached = editModuleWiring(routed, 'box', m => ({ ...m, ports: [...m.ports, { ...port, id: 'Q' }],
    portMappings: m.portMappings?.map(mapping => mappingId(mapping) === ids[1] ? { ...mapping, portId: 'Q' } : mapping) }));
  assert.deepEqual(round(reattached).layout?.topologyWireRoutes?.map(route => route.wire.id), [ids[0], ids[2]]);
  const store = createProjectStore(round(routed));
  assert.equal(store.commit(p => connectBoundaryPort(p, 'box', 'P', target('B'))).ok, false);
  assert.deepEqual(store.commit(p => removeWiring(p, 'box', { kind: 'mapping', id: ids[1] })), { ok: true });
  const kept = round(store.getSnapshot().project);
  assert.deepEqual(branches(box(kept)), [[ids[0], 'A'], [ids[2], 'C']]);
  assert.deepEqual(kept.layout?.topologyWireRoutes?.map(route => route.wire.id), [ids[0], ids[2]]);
  const impact = planPortDeletion(kept, 'box', 'P')!;
  assert.equal(impact.impacts.filter(item => item.kind === '端口映射').length, 3);
  assert.equal(box(impact.project).portMappings?.length, 0);
  store.undo();
  assert.deepEqual(round(store.getSnapshot().project), round(routed));
  store.redo();
  assert.deepEqual(round(store.getSnapshot().project), kept);

  let seq = 0;
  const copy = round(pasteModule(routed, routed, ['left'], [], 'copy', () => 'copy-' + ++seq));
  const clone = resolveHierarchy(copy).resolveInstance(['copy'])!.definition as ModuleDefinition;
  assert.notEqual(clone.id, 'box');
  assert.deepEqual(branches(clone), branches(box(wired)));
  assert.deepEqual(copy.layout?.topologyWireRoutes?.filter(r => r.modulePath[0] === 'copy').map(r => r.wire.id), ids);
  assert.equal(box(removeWiring(copy, clone.id, { kind: 'mapping', id: ids[1] })).portMappings!.length, 3);
});

test('a grouped branch resolves through each level; dissolution preserves the junction with or without an enclosing port', () => {
  const wired = fan();
  const grouped = round(groupModule(wired, [['left','A'], ['left','C']], '组', 'group', 'group-def'));
  const tree = resolveHierarchy(grouped);
  const result = tree.resolvePort({ instancePath: [], portId: 'P' });
  assert.equal(result.status, 'branched');
  assert.deepEqual(result.branches.map(branch => branch.chain.at(-1)?.instancePath), [
    ['left','group','A'], ['left','B'], ['left','group','C'],
  ]);
  const restored = planDissolveModule(grouped, ['left', 'group']);
  assert.ok(restored.ok);
  assert.deepEqual(branches(box(round(restored.project))), branches(box(wired)));

  const promoted = planDissolveModule(wired, ['left']);
  assert.ok(promoted.ok);
  assert.deepEqual(round(promoted.project).moduleDefinitions[0].portMappings!.map(m => m.target.instanceId), ['A','B','C']);
  assert.deepEqual(branches(box(promoted.project)), branches(box(wired)));
  const throughWire = editModule(wired, 'root', root => ({ ...root, portMappings: [],
    connections: [{ id: 'feed', from: target('left'), to: target('right') }] }));
  const unwrapped = planDissolveModule(throughWire, ['left']);
  assert.ok(unwrapped.ok);
  assert.deepEqual(round(unwrapped.project).moduleDefinitions[0].connections!.map(wire => [wire.from.instanceId, wire.to.instanceId]),
    [['A', 'right'], ['A', 'B'], ['A', 'C']]);
});

test('moving a mapped load disconnects just its explicit branch and reports the edit', () => {
  const project = editModule(fan(), 'root', root => ({ ...root, instances: root.instances.slice(0, 1) }));
  const move = planInstanceMove(project, ['left','B'], []);
  assert.ok(move.ok);
  assert.equal(move.wiring.disconnected, 1);
  const remaining = branches(box(round(move.project)));
  assert.deepEqual(remaining, branches(box(project)).filter(([, child]) => child !== 'B'));
});

test('AC capacity and actual consumption can be declared independently of the input ratings', () => {
  const acOut = { ...port, direction: 'out' as const, supplyCapacity: { unit: 'W' as const, value: { kind: 'fixed' as const, value: 12 } } };
  const acIn = { ...port, acLoadW: { kind: 'parameter' as const, parameterId: 'watts' }, inputRating: { unit: 'W' as const, max: 6 } };
  const device = { ...base.componentDefinitions[0], parameters: [
    { kind: 'numeric' as const, id: 'watts', name: '输入功耗', unit: 'W' as const, valueKind: 'fixed' as const, range: { min: 0 } },
  ] };
  const setup = (p: typeof device.ports[number]) => ({ ...base, componentDefinitions: [{ ...device, ports: [p] }] });
  assert.deepEqual(round(setup(acIn)).componentDefinitions[0].ports[0], acIn);
  assert.deepEqual(round(setup(acOut)).componentDefinitions[0].ports[0], acOut);
  assert.throws(() => round(setup({ ...acOut, supplyCapacity: { ...acOut.supplyCapacity, unit: 'A' } })), /固定 W/);
  assert.throws(() => round(setup({ ...acOut, acLoadW: acIn.acLoadW })), /交流输入端口/);
  assert.throws(() => round(setup({ ...acIn, acLoadW: { kind: 'fixed', value: -1 } })), /交流负载功耗/);
});

test('dissolving a meshed junction contracts self-loops and preserves references to surviving physical wires', () => {
  const wired = fan();
  const nested = editModule(wired, 'box', m => ({ ...m,
    ports: [...m.ports, { ...port, id: 'Q' }, { ...port, id: 'R' }],
    portMappings: [...m.portMappings!, { portId: 'Q', target: target('A') }, { portId: 'R', target: target('B') }],
    connections: [{ id: 'AB', from: target('A'), to: target('B') }],
  }));
  const mesh = editModule(nested, 'root', m => ({ ...m, portMappings: [], connections: [
    { id: 'loop', from: target('left'), to: { instanceId: 'left', portId: 'Q' } },
    { id: 'parallel', from: target('left'), to: { instanceId: 'left', portId: 'R' } },
  ] }));
  const plan = planDissolveModule({ ...mesh, namedLinks: [{ id: 'link', name: 'Test',
    via: ['loop', 'parallel'].map(connectionId => ({ scopePath: [], connectionId })) }] }, ['left']);
  assert.ok(plan.ok, !plan.ok ? plan.message : undefined);
  const restored = round(plan.project);
  assert.deepEqual(restored.moduleDefinitions[0].connections!.map(wire => [wire.from.instanceId, wire.to.instanceId]), [['A','B'], ['A','C']]);
  assert.deepEqual(restored.namedLinks![0].via, [{ scopePath: [], connectionId: 'AB' }]);
});
