
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dragFrame, keepNodeInside, moduleExtent } from '../../src/editors/topology/v1/frame-geometry';
import { hierarchyKey } from '../../src/editors/topology/v1/hierarchy-view';
import { frameInsets } from '../../src/editors/topology/v1/module-frame';
import { insertCanvasItem, preserveDeletionLayout } from '../../src/editors/topology/v1/topology-layout-edits';
import { projectTopology } from '../../src/editors/topology/v1/topology-projection';
import { resolveHierarchy } from '../../src/engine/v1/hierarchy';
import { blankModuleId } from '../../src/library/v1/built-in';
import type { InstancePath, ModuleDefinition, Project } from '../../src/model/v1/types';
import { createProjectStore } from '../../src/state/v1/project-store';
import { removeTopologyInstance } from '../../src/state/v1/remove-topology-object';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const instance = (id: string, definitionId = id) => ({ id, name: id, definitionId });
const module = (id: string, instances: ModuleDefinition['instances'] = []): ModuleDefinition =>
  ({ kind: 'module', id, name: id, ports: [], instances });
const fixture: Project = {
  id: 'frames', name: 'Frames', rootModuleDefinitionId: 'root',
  componentDefinitions: [{ kind: 'component', id: 'device', name: 'Device', ports: [] }],
  moduleDefinitions: [
    module('root', [instance('a', 'outer'), instance('b', 'outer'), instance('c', 'outer'), instance('other')]),
    module('outer', [instance('inner')]),
    module('inner', [instance('removed', 'box'), instance('device')]),
    module('box'), module('other', [instance('device')]),
  ],
  layout: { topology: [
    { instancePath: ['a', 'inner', 'removed'], x: 780, y: 440 },
    { instancePath: ['b', 'inner', 'removed'], x: 920, y: 600 },
  ] },
};
const expanded = new Set<ReturnType<typeof hierarchyKey>>([['a'], ['a', 'inner'], ['b'], ['b', 'inner'], ['other']].map(hierarchyKey));
const measured = new Map<string, { width: number; height: number }>();
const projectView = (project: Project) =>
  projectTopology(project, [...resolveHierarchy(project).walkInstances()], [], expanded, measured);
const item = (view: ReturnType<typeof projectView>, path: InstancePath) => view.nodeByKey.get(hierarchyKey(path))!;

test('dragging children and shrinking frame edges reserve 45 on port sides and 28 on empty sides', () => {
  const input = { id: 'OPT_IN', type: 'OPTICAL', direction: 'in' } as const;
  const output = { id: 'RF_OUT', type: 'RF', direction: 'out' } as const;
  const frame = { x: 10, y: 20, width: 900, height: 300 };
  const child = { x: 250, y: 120, width: 400, height: 80 };
  for (const [ports, left, right] of [[[], 28, 28], [[input], 45, 28], [[output], 28, 45], [[input, output], 45, 45]] as const) {
    const insets = frameInsets(ports);
    const extent = moduleExtent(frame, insets);
    assert.equal(keepNodeInside({ ...child, x: -1000 }, extent).x - frame.x, left);
    assert.equal(frame.x + frame.width - keepNodeInside({ ...child, x: 1000 }, extent).x - child.width, right);
    const west = dragFrame(frame, 'w', { x: 1000, y: 0 }, [child], insets);
    const east = dragFrame(frame, 'e', { x: -1000, y: 0 }, [child], insets);
    assert.equal(child.x - west.x, left);
    assert.equal(east.x + east.width - child.x - child.width, right);
  }
});

test('deletion preserves affected visible frames per occurrence and surviving default slots in one edit', () => {
  const store = createProjectStore(fixture);
  const initial = store.getSnapshot().project;
  const before = projectView(initial);
  assert.equal(initial.layout?.topologyFrames, undefined);
  const remove = (id: string, view: ReturnType<typeof projectView>) => store.commit(project =>
    preserveDeletionLayout(removeTopologyInstance(project, 'inner', id), 'inner', view, [], expanded, measured));

  assert.deepEqual(remove('removed', before), { ok: true });
  const edited = store.getSnapshot().project;
  const restored = parseProjectJson(serializeProjectJson(edited));
  const after = projectView(restored);
  for (const parent of ['a', 'b']) {
    assert.deepEqual(item(after, [parent]).frame?.display, item(before, [parent]).frame?.display);
    assert.deepEqual(item(after, [parent, 'inner']).frame?.display, item(before, [parent, 'inner']).frame?.display);
    assert.deepEqual(item(after, [parent, 'inner', 'device']).bounds, item(before, [parent, 'inner', 'device']).bounds);
  }
  assert.deepEqual(item(after, ['other']).frame, item(before, ['other']).frame);
  assert.equal(edited.layout?.topologyFrames?.some(frame => ['c', 'other'].includes(frame.modulePath[0])), false);
  assert.deepEqual(remove('device', after), { ok: true });
  assert.deepEqual(item(projectView(store.getSnapshot().project), ['a', 'inner']).frame?.display, item(before, ['a', 'inner']).frame?.display);
  store.undo();
  assert.equal(store.getSnapshot().project, edited);
  store.undo();
  assert.equal(store.getSnapshot().project, initial);
  store.redo();
  assert.equal(store.getSnapshot().project, edited);
});

test('canvas insertion grows a saved frame as part of the edit', () => {
  const frame = { modulePath: ['a', 'inner'], x: 0, y: 0, width: 360, height: 150 };
  const project = { ...fixture, layout: { ...fixture.layout, topologyFrames: [frame] } };
  const result = insertCanvasItem(project, { source: 'template', id: blankModuleId, name: 'Added' }, 'inner',
    frame.modulePath, 'added', { x: 390, y: 200 });
  assert.deepEqual(result.layout?.topologyFrames, [{ ...frame, width: 620, height: 276 }]);
  assert.deepEqual(result.layout?.topology?.at(-1), { instancePath: ['a', 'inner', 'added'], x: 390, y: 200 });
});
