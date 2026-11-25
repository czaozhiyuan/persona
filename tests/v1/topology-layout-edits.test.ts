
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
import { removeTopologyInstance, removeTopologyInstances } from '../../src/state/v1/remove-topology-object';
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

test('dragging children and shrinking frame edges reserve 86 px per occupied side and 28 px per empty side', () => {
  const input = { id: 'OPT_IN', type: 'OPTICAL', direction: 'in' } as const;
  const output = { id: 'RF_OUT', type: 'RF', direction: 'out' } as const;
  const frame = { x: 10, y: 20, width: 900, height: 300 };
  const child = { x: 250, y: 120, width: 400, height: 80 };
  const ac = { ...input, id: 'AC', type: 'AC_POWER' } as const;
  const dc = { ...output, id: 'DC', type: 'DC_POWER' } as const;
  for (const [ports, left, right] of [[[], 28, 28], [[input], 86, 28], [[output], 28, 86], [[input, output], 86, 86],
    [[ac], 86, 28], [[dc], 28, 86], [[input, ac, output, dc], 86, 86]] as const) {
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

test('projection grows a tight saved frame for both columns and preserves a fitting child in nested and internal views', () => {
  const path = ['other'], child = [...path, 'device'];
  const bounds = { x: 86, y: 90, width: 400, height: 80 };
  const input = { id: 'in', direction: 'in', type: 'RF' } as const;
  const output = { id: 'out', direction: 'out', type: 'RF' } as const;
  const project = (ports: ModuleDefinition['ports'], width: number): Project => ({
    ...fixture, moduleDefinitions: fixture.moduleDefinitions.map(d => d.id === 'other' ? { ...d, ports } : d),
    layout: { topology: [{ instancePath: child, x: bounds.x, y: bounds.y }],
      topologyFrames: [{ modulePath: path, x: 0, y: 0, width, height: 260 }] },
  });
  for (const scope of [[], path]) {
    for (const [ports, savedWidth, expectedWidth] of [
      [[input, output], 530, 572], [[input, output], 600, 600], [[input], 600, 600], [[], 600, 600],
    ] as const) {
      const p = project(ports, savedWidth);
      const view = projectTopology(p, [...resolveHierarchy(p).walkInstances()], scope, expanded,
        new Map([[hierarchyKey(child), bounds]]));
      assert.equal(item(view, path).frame!.display.width, expectedWidth);
      assert.deepEqual(item(view, child).bounds, bounds);
    }
  }
});

test('rendered multiline rows set the minimum projected and resized height per occurrence', () => {
  const key = hierarchyKey(['a', 'inner']);
  const ports = [{ id: 'IN', direction: 'in', type: 'RF', name: '监测\n'.repeat(50).trim() }] as const;
  const project = { ...fixture, moduleDefinitions: fixture.moduleDefinitions.map(d => d.id === 'inner' ? { ...d, ports } : d) };
  const instances = [...resolveHierarchy(project).walkInstances()];
  const view = projectTopology(project, instances, [], expanded, measured, undefined, new Map([[key, { side: 900, top: 0 }]]));
  const frame = view.nodeByKey.get(key)!.frame!.display;
  const insets = frameInsets(ports, 900);
  assert.equal(frame.height, insets.height);
  assert.equal(dragFrame(frame, 's', { x: 0, y: -2000 }, [], insets).height, frame.height);
  assert.ok(item(view, ['b', 'inner']).frame!.display.height < frame.height);
  assert.deepEqual(item(view, ['a', 'inner', 'device']).bounds, item(projectView(project), ['a', 'inner', 'device']).bounds);
});

test('top ports reserve their measured band above the title, children and side pins', () => {
  const port = { id: 'COM', type: 'OPTICAL', direction: 'bidirectional' } as const;
  const ordinary = frameInsets([]);
  const insets = frameInsets([port], { top: 64, side: 120 });
  assert.deepEqual([insets.left, insets.right], [ordinary.left, ordinary.right]);
  assert.equal(insets.top, ordinary.top + 64);
  const frame = { x: 10, y: 20, width: 500, height: 400 };
  assert.equal(moduleExtent(frame, insets)[0][1], frame.y + insets.top);
  assert.equal(dragFrame(frame, 's', { x: 0, y: -500 }, [], insets).height, insets.top + 120 + 28);
  assert.equal(frameInsets(Array(8).fill(port)).minWidth, 8 * 64 + 2 * 28);
});

test('deletion preserves affected visible frames per occurrence and surviving default slots in one edit', () => {
  const store = createProjectStore(fixture);
  const initial = store.getSnapshot().project;
  const before = projectView(initial);
  assert.equal(initial.layout?.topologyFrames, undefined);
  const remove = (id: string, view: ReturnType<typeof projectView>) => store.commit(project =>
    preserveDeletionLayout(removeTopologyInstance(project, 'inner', id), new Set(['inner']), view, [], expanded, measured));

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

test('batch deletion empties shared and independent parents using one projection and one undo entry', () => {
  const store = createProjectStore(fixture);
  const initial = store.getSnapshot().project;
  const before = projectView(initial);
  const paths = [['a', 'inner', 'device'], ['b', 'inner', 'removed'], ['b', 'inner', 'device'], ['other', 'device'], ['c']];
  store.selectInstances(paths);
  const edit = (paths: string[][]) => store.commit(project => {
    const removed = removeTopologyInstances(project, paths);
    return preserveDeletionLayout(removed.project, removed.affected, before, [], expanded, measured);
  });
  assert.equal(edit([...paths, ['missing']]).ok, false);
  assert.equal(store.getSnapshot().project, initial);
  assert.equal(store.getSnapshot().canUndo, false);
  assert.deepEqual(edit(paths), { ok: true });
  const edited = store.getSnapshot().project;
  const restored = parseProjectJson(serializeProjectJson(edited));
  for (const id of ['inner', 'other']) assert.deepEqual(restored.moduleDefinitions.find(d => d.id === id)?.instances, []);
  assert.equal(resolveHierarchy(restored).resolveInstance(['c']), undefined);
  const after = projectView(restored);
  for (const path of [['a'], ['b'], ['a', 'inner'], ['b', 'inner'], ['other']]) {
    assert.deepEqual(item(after, path).frame?.display, item(before, path).frame?.display);
    assert.deepEqual(item(after, path).bounds, item(before, path).bounds);
  }
  assert.equal(store.getSnapshot().selection.instancePath, undefined);
  assert.equal(store.getSnapshot().selection.instancePaths, undefined);
  store.undo();
  assert.equal(store.getSnapshot().project, initial);
  assert.equal(store.getSnapshot().canUndo, false);
  store.redo();
  assert.equal(store.getSnapshot().project, edited);
});

test('a shared ancestor removed at another occurrence covers its selected descendants', () => {
  const project = { ...fixture, moduleDefinitions: fixture.moduleDefinitions.map(d => d.id === 'root'
    ? { ...d, instances: [...d.instances, instance('separate', 'inner'), instance('wrapper')] } : d).concat(
    module('wrapper', [instance('deep', 'outer')])) };
  const paths = [['b', 'inner', 'device'], ['wrapper', 'deep', 'inner'], ['wrapper', 'deep', 'inner', 'removed']];
  for (const selection of [paths, [...paths].reverse()]) {
    const result = removeTopologyInstances(project, selection);
    assert.deepEqual([...result.affected], ['outer']);
    const hierarchy = resolveHierarchy(result.project);
    assert.equal(hierarchy.resolveInstance(['a', 'inner']), undefined);
    assert.ok(hierarchy.resolveInstance(['separate', 'device']));
    assert.ok(hierarchy.resolveInstance(['separate', 'removed']));
  }
});

test('canvas insertion grows a saved frame as part of the edit', () => {
  const frame = { modulePath: ['a', 'inner'], x: 0, y: 0, width: 360, height: 150 };
  const project = { ...fixture, layout: { ...fixture.layout, topologyFrames: [frame] } };
  const result = insertCanvasItem(project, { source: 'template', id: blankModuleId, name: 'Added' }, 'inner',
    frame.modulePath, 'added', { x: 390, y: 200 });
  assert.deepEqual(result.layout?.topologyFrames, [{ ...frame, width: 620, height: 276 }]);
  assert.deepEqual(result.layout?.topology?.at(-1), { instancePath: ['a', 'inner', 'added'], x: 390, y: 200 });
});

test('center insertion grows the current occurrence in local coordinates without shifting previously clamped siblings', () => {
  const scope = ['a', 'inner'];
  const saved = { modulePath: scope, x: 0, y: 0, width: 360, height: 150 };
  const sibling = [...scope, 'removed'];
  const store = createProjectStore({ ...fixture, layout: { topology: [{ instancePath: sibling, x: -80, y: -20 }], topologyFrames: [saved] } });
  const localView = (p: Project) => projectTopology(p, [...resolveHierarchy(p).walkInstances()], scope, expanded, measured);
  const original = store.getSnapshot().project;
  const projection = localView(original);
  const position = { x: -320, y: -180 };
  const inserted = [...scope, 'added'];
  assert.deepEqual(store.commit(p => insertCanvasItem(p, { source: 'project', id: 'device', name: 'New' }, 'inner', scope, 'added',
    () => ({ position, projection }))), { ok: true });
  const restored = parseProjectJson(serializeProjectJson(store.getSnapshot().project));
  const after = localView(restored);
  assert.deepEqual(item(after, inserted).preferred, position);
  assert.deepEqual(item(after, sibling).bounds, item(projection, sibling).bounds);
  assert.deepEqual(restored.layout?.topologyFrames, [{ modulePath: scope, x: -348, y: -232, width: 708, height: 382 }]);
  assert.equal(restored.layout?.topology?.some(p => p.instancePath[0] === 'b' && p.instancePath.at(-1) === 'added'), false);
  store.undo();
  assert.equal(store.getSnapshot().project, original);
});
