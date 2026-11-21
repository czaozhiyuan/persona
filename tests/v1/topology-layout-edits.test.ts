
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hierarchyKey } from '../../src/editors/topology/v1/hierarchy-view';
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
