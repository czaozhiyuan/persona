import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveHierarchy } from '../../src/engine/v1/hierarchy';
import { calculateDcBudget } from '../../src/engine/v1/dc-budget';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import { arrangeScope } from '../../src/editors/topology/v1/auto-arrange';
import { projectInlineExpansion } from '../../src/editors/topology/v1/inline-expansion-layout';
import { handleId, nodeId, projectWiring } from '../../src/editors/topology/v1/topology-wiring';
import type { InstancePath, Project } from '../../src/model/v1/types';
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

test('rejects an unmeasured pin or an oversized scope before applying any partial layout', async () => {
  const p = example(), { view, edges } = input(p, []);
  await assert.rejects(arrangeScope(p, view, edges, () => ({ width: 200, height: 90, handles: new Map() })), /端口位置/);
  const root = view.scopes.get(view.rootKey)!;
  view.scopes.set(view.rootKey, { ...root, members: Array(301).fill(root.members[0]) });
  await assert.rejects(arrangeScope(p, view, edges, () => undefined), /过多/);
});
