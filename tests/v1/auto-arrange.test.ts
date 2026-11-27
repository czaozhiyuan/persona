import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveHierarchy } from '../../src/engine/v1/hierarchy';
import { calculateDcBudget } from '../../src/engine/v1/dc-budget';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import { arrangeScope } from '../../src/editors/topology/v1/auto-arrange';
import { projectInlineExpansion } from '../../src/editors/topology/v1/inline-expansion-layout';
import { handleId, nodeId, projectWiring } from '../../src/editors/topology/v1/topology-wiring';
import type { ComponentDefinition, InstancePath, ModuleDefinition, Project } from '../../src/model/v1/types';
import { parseProjectJson } from '../../src/storage/v1/project-json';
import { digitalControlProject } from './fixtures/digital-control-project';

const example = () => parseProjectJson(readFileSync(new URL('../../examples/v1-project.json', import.meta.url), 'utf8'));
function input(p: Project, scope: InstancePath) {
  const instances = [...resolveHierarchy(p).walkInstances()];
  const { view } = projectInlineExpansion(p, instances, scope, new Set(), new Map());
  const nodes = view.scopes.get(view.rootKey)!.members;
  const measure = (id: string) => {
    const n = nodes.find(n => nodeId(n.key) === id)!;
    const { width, height } = n.bounds;
    const handles = new Map(n.item.definition.ports.map((p, i) => [handleId(p.id),
      { x: p.direction === 'in' ? 0 : p.direction === 'out' ? width : width / 2, y: p.direction === 'bidirectional' ? 0 : 18 + i * 8 }]));
    return { width, height, handles };
  };
  return { view, edges: projectWiring(view, new Map()).edges, measure };
}
const run = (p: Project, scope: InstancePath) => {
  const { view, edges, measure } = input(p, scope);
  return arrangeScope(p, view, edges, measure);
};

test('layered arrangement uses signal roles, reserves neighbours for supplies and keeps other scopes and budgets intact', async () => {
  const p = example(), scope = ['TX_A'];
  const next = await run(p, scope);
  assert.equal(next.moduleDefinitions, p.moduleDefinitions);
  assert.equal(next.namedLinks, p.namedLinks);
  assert.equal(next.layout?.topologyWireRoutes, p.layout?.topologyWireRoutes);
  const own = next.layout!.topology!.filter(n => n.instancePath[0] === 'TX_A' && n.instancePath.length === 2);
  const other = (rows: typeof own) => rows.filter(n => !own.some(o => JSON.stringify(n.instancePath) === JSON.stringify(o.instancePath)));
  assert.deepEqual(other([...next.layout!.topology!]), other([...(p.layout!.topology ?? [])]));
  assert.ok(own.every(n => n.x % 10 === 0 && n.y % 10 === 0));
  const pos = (id: string) => own.find(n => n.instancePath[1] === id)!;
  assert.ok(pos('mzm').x < pos('optical-switch').x);
  assert.ok(pos('laser').x <= pos('mzm').x);
  assert.ok(pos('laser').y !== pos('mzm').y || pos('laser').x !== pos('mzm').x);
  assert.equal(await run(next, scope), next);
  const metrics = (p: Project) => {
    const budget = createLinkBudget(p);
    return { links: p.namedLinks!.map(l => budget.calculateNamedLink(l, { frequencyGHz: 1, inputPowerDbm: 0 })),
      dc: calculateDcBudget(p) };
  };
  assert.deepEqual(metrics(next), metrics(p));
});

test('digital CONTROL endpoints and MPO cores drive the main chain and duplex feedback has stable ordering', async () => {
  const duplex = digitalControlProject();
  const [root, box] = duplex.moduleDefinitions;
  const project = { ...duplex, moduleDefinitions: [{ ...root,
    connections: root.connections!.filter(w => w.id === 'tx-a' || w.id === 'rx-b'),
    cableBundles: root.cableBundles!.map(bundle => ({ ...bundle, cores: bundle.cores.slice(0, 1) })),
  }, box] };
  const arranged = await run(project, []);
  const x = (id: string) => arranged.layout!.topology!.find(n => n.instancePath[0] === id)!.x;
  assert.ok(x('ctl-a') < x('a') && x('a') < x('b') && x('b') < x('ctl-b'));
  const { view, edges, measure } = input(duplex, []);
  assert.deepEqual(await arrangeScope(duplex, view, edges, measure), await arrangeScope(duplex, view, [...edges].reverse(), measure));
});

function wrapRootChildren(p: Project, count: number): Project {
  const root = p.moduleDefinitions.find(m => m.id === p.rootModuleDefinitionId)!;
  const modules = [...p.moduleDefinitions.filter(m => m !== root)];
  const instances = root.instances.map(slot => {
    let child = [...p.componentDefinitions, ...p.moduleDefinitions].find(d => d.id === slot.definitionId)!;
    for (let i = 0; i < count; i++) {
      const wrapper: ModuleDefinition = { kind: 'module', id: slot.id + '-wrapper-' + i, name: 'module',
        instances: [{ ...(i === 0 ? slot : {}), id: 'nested', name: 'child', definitionId: child.id }],
        ports: child.ports.map(({ id, type, direction }) => ({ id: 'outer-' + id, type, direction })),
        portMappings: child.ports.map(port => ({ portId: 'outer-' + port.id, target: { instanceId: 'nested', portId: port.id } })) };
      modules.push(wrapper);
      child = wrapper;
    }
    return count ? { id: slot.id, name: slot.name, definitionId: child.id } : slot;
  });
  const ref = (end: { instanceId: string; portId: string }) => ({ ...end, portId: 'outer-'.repeat(count) + end.portId });
  modules.push({ ...root, instances, connections: root.connections?.map(c => ({ ...c, from: ref(c.from), to: ref(c.to) })) });
  return { ...p, moduleDefinitions: modules };
}

test('three reverse auxiliary status wires do not invert RF stages through zero, one or two mapped boundaries', async () => {
  const chips: ComponentDefinition[] = ['a', 'b'].map(id => ({ kind: 'component', id, name: 'stage',
    ports: [{ id: 'in', type: 'RF', direction: 'in' }, { id: 'out', type: 'RF', direction: 'out' },
      ...[0, 1, 2].map(i => ({ id: 's' + i, type: 'CONTROL' as const, direction: id === 'a' ? 'in' as const : 'out' as const }))],
    transfers: [{ kind: 'rf', fromPortId: 'in', toPortId: 'out' }] }));
  const end = (instanceId: string, portId: string) => ({ instanceId, portId });
  const root: ModuleDefinition = { kind: 'module', id: 'root', name: 'root', ports: [],
    instances: chips.map(d => ({ id: d.id, name: d.name, definitionId: d.id })),
    connections: [{ id: 'rf', from: end('a', 'out'), to: end('b', 'in') },
      ...[0, 1, 2].map(i => ({ id: 'status' + i, from: end('b', 's' + i), to: end('a', 's' + i) }))] };
  const p: Project = { id: 'aux', name: 'aux', rootModuleDefinitionId: root.id, componentDefinitions: chips, moduleDefinitions: [root] };
  for (const depth of [0, 1, 2]) {
    const result = await run(wrapRootChildren(p, depth), []);
    const pos = result.layout!.topology!;
    assert.ok(pos.find(n => n.instancePath[0] === 'a')!.x < pos.find(n => n.instancePath[0] === 'b')!.x, 'depth ' + depth);
  }
});

test('EO supply and genuine digital transfers preserve their layout roles through renamed nested ports', async () => {
  const p = example();
  const tx = p.moduleDefinitions.find(d => d.instances.some(i => i.id === 'mzm') && d.instances.some(i => i.id === 'laser'))!;
  const analog: Project = { ...p, rootModuleDefinitionId: tx.id, namedLinks: [], layout: undefined, instanceSettings: undefined,
    moduleDefinitions: [{ ...tx, ports: [], portMappings: [], parameterMappings: [], cableBundles: [] }] };
  const baseline = await run(analog, []);
  const wrapped = await run(wrapRootChildren(analog, 2), []);
  assert.deepEqual(wrapped.layout?.topology, baseline.layout?.topology);

  const digital = digitalControlProject(), [root, box] = digital.moduleDefinitions;
  const project: Project = { ...digital, namedLinks: [], componentDefinitions: digital.componentDefinitions.map(d => d.id === 'controller'
    ? { ...d, ports: [...d.ports, { id: 'analog', type: 'RF', direction: 'in' }] } : d),
    moduleDefinitions: [{ ...root, cableBundles: [], connections: root.connections!.filter(c => c.id === 'tx-a' || c.id === 'rx-b') }, box] };
  const result = await run(wrapRootChildren(project, 2), []);
  const x = (id: string) => result.layout!.topology!.find(n => n.instancePath[0] === id)!.x;
  assert.ok(x('ctl-a') < x('a') && x('b') < x('ctl-b'));
});

test('rejects an unmeasured pin or an oversized scope before applying any partial layout', async () => {
  const p = example(), { view, edges } = input(p, []);
  await assert.rejects(arrangeScope(p, view, edges, () => ({ width: 200, height: 90, handles: new Map() })), /端口位置/);
  const root = view.scopes.get(view.rootKey)!;
  view.scopes.set(view.rootKey, { ...root, members: Array(301).fill(root.members[0]) });
  await assert.rejects(arrangeScope(p, view, edges, () => undefined), /过多/);
});
