import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolveHierarchy } from '../../src/engine/v1/hierarchy';
import { createPathResolver } from '../../src/engine/v1/path-resolver';
import { displayDepth, hierarchyKey } from '../../src/editors/topology/v1/hierarchy-view';
import { projectPathHighlight } from '../../src/editors/topology/v1/path-highlight';
import { projectTopology, toLocalPosition } from '../../src/editors/topology/v1/topology-projection';
import { handleId, nodeId, portKey, projectWiring, scopedWiringProblem } from '../../src/editors/topology/v1/topology-wiring';
import { exampleProject } from '../../src/model/v1/example';
import { moveTopologyNode } from '../../src/state/v1/topology-edits';
import { parseProjectJson } from '../../src/storage/v1/project-json';

const paths = (...items: string[][]) => new Set(items.map(hierarchyKey));

test('each actual module path expands independently, including reused definitions at arbitrary depth', () => {
  const instances = [...resolveHierarchy(exampleProject).walkInstances()];
  const collapsed = projectTopology(exampleProject, instances, [], paths(), new Map());
  const branchA = instances.filter(item => item.definition.kind === 'module' && item.instancePath[0] === 'TX_A');
  const expanded = new Set(branchA.map(item => hierarchyKey(item.instancePath)));
  assert.equal(displayDepth(instances, []), 5);
  assert.equal(displayDepth(instances, [], expanded), 5);
  assert.equal(displayDepth(instances, ['TX_B'], expanded), 1);
  assert.deepEqual(collapsed.nodes.map(node => node.item.instancePath), [['TX_A'], ['TX_B']]);

  const projected = projectTopology(exampleProject, instances, [], expanded, new Map());
  const component = ['TX_A', 'TX_SLOT', 'TX_CBB', 'MZM_MODULE', 'MZM_OPTICAL'];
  const a = projected.nodeByKey.get(hierarchyKey(component))!;
  assert.equal(a.parentKey, hierarchyKey(component.slice(0, -1)));
  assert.equal(projected.nodeByKey.has(hierarchyKey(['TX_B', ...component.slice(1)])), false);
  assert.ok(projected.nodeByKey.get(hierarchyKey(['TX_A']))?.frame);
  assert.equal(projected.nodeByKey.get(hierarchyKey(['TX_B']))?.frame, undefined);
  assert.deepEqual(projected.nodeByKey.get(hierarchyKey(['TX_B']))?.position, collapsed.nodes[1].position);
});

test('drag coordinates are local to their immediate module and moving a parent leaves child positions intact', () => {
  const project = moveTopologyNode(exampleProject, ['TX_A', 'TX_SLOT'], { x: 180, y: 60 });
  const instances = [...resolveHierarchy(project).walkInstances()];
  const path = ['TX_A', 'TX_SLOT'];
  const open = paths(['TX_A']);
  const projectView = (value: typeof project, scope: string[], expanded = open) =>
    projectTopology(value, instances, scope, expanded, new Map());
  const inline = projectView(project, []);
  const child = inline.nodeByKey.get(hierarchyKey(path))!;
  const standalone = projectView(project, ['TX_A']).nodeByKey.get(child.key)!;
  assert.deepEqual(child.position, standalone.position);
  assert.deepEqual(toLocalPosition(child.position, child.offset), { x: 180, y: 60 });
  const moved = moveTopologyNode(project, ['TX_A'], { x: 95, y: 120 });
  const reopened = projectView(moved, [], open);
  const a = reopened.nodeByKey.get(hierarchyKey(['TX_A']))!;
  assert.deepEqual(a.position, { x: 95, y: 120 });
  assert.deepEqual(reopened.nodeByKey.get(child.key)?.position, child.position);
  assert.deepEqual(projectView(moved, [], paths()).nodeByKey.get(a.key)?.position, a.position);
  assert.deepEqual(reopened.nodeByKey.get(hierarchyKey(['TX_B']))?.position, { x: 300, y: 80 });
});

test('expanded boundaries separate internal mappings from external wiring and scope highlights by occurrence', () => {
  const project = parseProjectJson(readFileSync(new URL('../../examples/v1-project.json', import.meta.url), 'utf8'));
  const instances = [...resolveHierarchy(project).walkInstances()];
  const result = createPathResolver(project).resolveNamedLink(project.namedLinks!.find(link => link.id === 'full')!, {
    opticalSources: [{ instancePath: ['TX_A', 'laser'], portId: 'OUT', channelId: 'DWDM_CH28' }],
  });
  assert.equal(result.status, 'resolved');
  const expanded = projectTopology(project, instances, [], paths(['TX_A'], ['TX_B']), new Map());
  const highlights = new Map([...expanded.scopes].map(([key, { path }]) =>
    [key, projectPathHighlight(result, path)]));
  const { edges, ports } = projectWiring(expanded, highlights);
  const a = nodeId(hierarchyKey(['TX_A']));
  const port = (path: string[], id: string, inner = false) => ports.get(portKey(nodeId(hierarchyKey(path)), handleId(id, inner)));
  const core = edges.find(edge => edge.data?.kind === 'core' && edge.data.id === 'wdm')!;
  assert.equal(core.source, a);
  assert.equal(core.sourceHandle, handleId('OPT_OUT'));
  assert.equal(core.className, 'v1-path-edge');
  const mapping = edges.find(edge => edge.data?.kind === 'mapping' && edge.data.scope[0] === 'TX_A')!;
  assert.equal(mapping.target, a);
  assert.equal(mapping.targetHandle, handleId('OPT_OUT', true));
  assert.equal(mapping.className, 'v1-path-edge');
  assert.equal(edges.some(edge => edge.data?.scope[0] === 'TX_B' && !!edge.className), false);
  assert.match(scopedWiringProblem(port(['TX_A', 'laser'], 'OUT'), port(['TX_B'], 'OPT_OUT', true))!, /不能直接跨层/);
});
