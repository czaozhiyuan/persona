import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hierarchyKey } from '../../src/editors/topology/v1/hierarchy-view';
import { frameHeader, framePadding, type FramePortHeights } from '../../src/editors/topology/v1/module-frame';
import { planInlineExpansion, projectInlineExpansion } from '../../src/editors/topology/v1/inline-expansion-layout';
import { moveInView } from '../../src/editors/topology/v1/topology-layout-edits';
import { projectTopology } from '../../src/editors/topology/v1/topology-projection';
import { resolveHierarchy } from '../../src/engine/v1/hierarchy';
import type { InstancePath, Project } from '../../src/model/v1/types';
import { moveTopologyNodes, resizeTopologyFrame } from '../../src/state/v1/topology-edits';
import { createProjectStore } from '../../src/state/v1/project-store';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const receiver = ['receiver'], board = [...receiver, 'board'];
const instance = (id: string, definitionId = id) => ({ id, definitionId, name: id });
const at = (instancePath: InstancePath, x: number, y: number) => ({ instancePath, x, y });
function fixture(width: number, height: number): Project {
  return {
    id: 'expansion', name: 'Expansion', rootModuleDefinitionId: 'root',
    componentDefinitions: [{ id: 'device', kind: 'component', name: 'Device', ports: [] }],
    moduleDefinitions: [
      { id: 'root', kind: 'module', name: 'Root', ports: [], instances: [instance('receiver'), instance('other', 'receiver')] },
      { id: 'receiver', kind: 'module', name: 'Receiver', ports: [], instances:
        [instance('board'), instance('pd', 'device'), instance('amp', 'device'), instance('fixed', 'device')] },
      { id: 'board', kind: 'module', name: 'Board', ports: [], instances: [instance('inside', 'device')] },
    ],
    layout: {
      topology: [at(receiver, 50, 80), at(['other'], 1700, 80), at(board, 100, 40), at([...receiver, 'pd'], 220, 70),
        at([...receiver, 'amp'], 350, 140), at([...receiver, 'fixed'], -2, 2000)],
      topologyFrames: [{ modulePath: receiver, x: -30, y: -40, width, height },
        { modulePath: board, x: 0, y: 0, width: 360, height: 200 }],
    },
  };
}
function viewArgs(project: Project, scope: InstancePath, expanded: InstancePath[], portHeights?: ReadonlyMap<string, FramePortHeights>) {
  const instances = [...resolveHierarchy(project).walkInstances()];
  const measured = new Map(instances.map(i => [hierarchyKey(i.instancePath), { width: 84, height: 50 }]));
  return [project, instances, scope, new Set(expanded.map(hierarchyKey)), measured, undefined, portHeights] as const;
}
function view(...args: Parameters<typeof viewArgs>) {
  return projectTopology(...viewArgs(...args));
}
function object(view: ReturnType<typeof projectTopology>, path: InstancePath) {
  return view.nodeByKey.get(hierarchyKey(path))!;
}
const apply = (p: Project, { moves, frames }: ReturnType<typeof planInlineExpansion>) =>
  frames.reduce(resizeTopologyFrame, moveTopologyNodes(p, moves));
const key = new Set([hierarchyKey(board)]);

test('expanding a child keeps displaced devices below the measured top optical port row and header', () => {
  const project = fixture(540, 300);
  const parent = project.moduleDefinitions.find(d => d.id === 'receiver')!;
  parent.ports = [{ id: 'COM', name: 'COM', type: 'OPTICAL', direction: 'bidirectional' }];
  const portHeights = new Map([[hierarchyKey(receiver), { side: 0, top: 112 }]]);
  const expanded = [receiver, board];
  const edit = planInlineExpansion(view(project, [], expanded, portHeights), key);
  assert.ok(edit.moves.some(move => move.instancePath.at(-1) === 'pd'));
  const after = view(apply(project, edit), [], expanded, portHeights);
  const frame = object(after, receiver).frame!;
  assert.equal(frame.insets.top, 112 + frameHeader);
  for (const item of after.scopes.get(hierarchyKey(receiver))!.members) {
    assert.ok(item.bounds.y >= frame.display.y + frame.insets.top, item.key);
  }
  assert.deepEqual(planInlineExpansion(after, key), { moves: [], frames: [] });
});

test('inline expansion pins the anchor, moves only obstructing siblings, and restores the manual layout on collapse', () => {
  const project = fixture(540, 300);
  const before = view(project, [], [receiver]);
  const edit = planInlineExpansion(view(project, [], [receiver, board]), key);
  assert.deepEqual(edit.frames.map(f => f.modulePath), [receiver]);
  assert.deepEqual(edit.moves.map(m => m.instancePath.at(-1)).sort(), ['amp', 'fixed', 'pd']);
  const stored = serializeProjectJson(project);
  const open = projectInlineExpansion(...viewArgs(project, [], [receiver, board])).view;
  const folded = projectInlineExpansion(...viewArgs(project, [], [receiver])).view;
  assert.equal(serializeProjectJson(project), stored);
  const old = object(before, receiver).frame!.display, frame = object(open, receiver).frame!.display;
  assert.deepEqual([frame.x, frame.y], [old.x, old.y]);
  assert.ok(frame.width >= old.width && frame.height > old.height);
  assert.deepEqual(object(folded, receiver).frame!.display, old);
  assert.deepEqual(object(open, board).bounds, object(before, board).bounds);
  assert.deepEqual(object(open, [...receiver, 'fixed']).bounds, object(before, [...receiver, 'fixed']).bounds);
  assert.deepEqual(object(open, ['other']).bounds, object(before, ['other']).bounds);
  const members = open.scopes.get(hierarchyKey(receiver))!.members.map(n => ({
    ...n.bounds, width: n.frame?.display.width ?? n.bounds.width, height: n.frame?.display.height ?? n.bounds.height,
  }));
  for (const [i, r] of members.entries()) {
    assert.ok(r.x >= frame.x && r.y >= frame.y && r.x + r.width <= frame.x + frame.width && r.y + r.height <= frame.y + frame.height);
    for (const other of members.slice(i + 1)) assert.ok(r.x + r.width <= other.x || other.x + other.width <= r.x ||
      r.y + r.height <= other.y || other.y + other.height <= r.y);
  }
  for (const name of ['pd', 'amp', 'fixed']) {
    assert.deepEqual(object(folded, [...receiver, name]).bounds, object(before, [...receiver, name]).bounds);
  }
  assert.deepEqual(planInlineExpansion(open, key), { moves: [], frames: [] });
});

test('a drag from a temporary slot saves only the manual move and required compact frame growth', () => {
  const project = fixture(540, 300);
  const path = [...receiver, 'pd'];
  const { manual, view: open } = projectInlineExpansion(...viewArgs(project, [], [receiver, board]));
  assert.notDeepEqual(object(manual, path).position, object(open, path).position);
  const drop = at(path, 480, 260);
  const moved = parseProjectJson(serializeProjectJson(moveInView(project, [drop], manual)));
  const stored = moved.layout!.topology!;
  assert.deepEqual(stored.find(p => hierarchyKey(p.instancePath) === hierarchyKey(path)), drop);
  const frame = moved.layout!.topologyFrames!.find(frame => hierarchyKey(frame.modulePath) === hierarchyKey(receiver))!;
  assert.equal(frame.width, drop.x + 84 + framePadding - frame.x);
  assert.equal(frame.height, drop.y + 50 + framePadding - frame.y);
  for (const expanded of [[receiver], [receiver, board]]) {
    const after = projectInlineExpansion(...viewArgs(moved, [], expanded)).view;
    assert.equal(object(after, path).bounds.x, drop.x);
    assert.equal(object(after, path).bounds.y, drop.y);
    assertSiblingsClear(after);
  }
  const folded = projectInlineExpansion(...viewArgs(moved, [], [receiver])).view;
  for (const name of ['amp', 'fixed']) {
    assert.deepEqual(object(folded, [...receiver, name]).bounds, object(manual, [...receiver, name]).bounds);
  }
});

test('uses free space inside the current editing scope and leaves an already clear layout untouched', () => {
  const project = fixture(940, 540);
  const edit = planInlineExpansion(view(project, receiver, [board]), key);
  assert.deepEqual(edit.frames, []);
  assert.deepEqual(edit.moves.map(m => m.instancePath.at(-1)).sort(), ['amp', 'pd']);
  assert.deepEqual(planInlineExpansion(view(apply(project, edit), receiver, [board]), key), { moves: [], frames: [] });
});

test('expanding several levels together grows all enclosing frames and releases only obstructing devices', () => {
  const source = fixture(540, 300);
  const project: Project = { ...source, moduleDefinitions: source.moduleDefinitions.map(d => d.id === 'root'
    ? { ...d, instances: [instance('receiver'), instance('outside', 'device')] } : d), layout: {
    topology: [...source.layout!.topology!.filter(p => p.instancePath[0] !== 'other'), at(['outside'], 385, 220)],
    topologyFrames: [...source.layout!.topologyFrames!, { modulePath: [], x: 0, y: 0, width: 550, height: 320 }],
  } };
  const expanded = [receiver, board], opened = new Set(expanded.map(hierarchyKey));
  const edit = planInlineExpansion(view(project, [], expanded), opened);
  assert.deepEqual(edit.frames.map(f => f.modulePath), [receiver, []]);
  assert.ok(edit.moves.some(m => hierarchyKey(m.instancePath) === '["outside"]'));
  const saved = apply(project, edit);
  assert.deepEqual(planInlineExpansion(view(saved, [], expanded), opened), { moves: [], frames: [] });
  const folded = projectInlineExpansion(...viewArgs(project, [], [])).view;
  assert.deepEqual(object(folded, []).frame!.display, view(project, [], []).nodeByKey.get('[]')!.frame!.display);
  assert.ok(object(view(saved, [], expanded), []).frame!.display.height > object(folded, []).frame!.display.height);
});

function displayedBounds(projection: ReturnType<typeof view>, path: InstancePath) {
  const { bounds, frame } = object(projection, path);
  return { ...bounds, width: frame?.display.width ?? bounds.width, height: frame?.display.height ?? bounds.height };
}

function assertSiblingsClear(projection: ReturnType<typeof view>) {
  for (const [key, scope] of projection.scopes) {
    const frame = projection.nodeByKey.get(key)?.frame;
    const members = scope.members.map(node => displayedBounds(projection, node.item.instancePath));
    for (const [index, a] of members.entries()) {
      if (frame) {
        assert.ok(a.x >= frame.display.x + frame.insets.left && a.y >= frame.display.y + frame.insets.top, key);
        assert.ok(a.x + a.width <= frame.display.x + frame.display.width - frame.insets.right, key);
        assert.ok(a.y + a.height <= frame.display.y + frame.display.height - framePadding, key);
      }
      for (const b of members.slice(index + 1)) {
        assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, key);
      }
    }
  }
}

test('opening one module displaces folded and expanded siblings as units while retaining clear positions', () => {
  const source = fixture(940, 540);
  const project: Project = { ...source, moduleDefinitions: source.moduleDefinitions.map(d => d.id === 'root' ? {
    ...d, instances: [instance('a', 'board'), instance('b', 'board'), instance('c', 'board'), instance('d', 'device'), instance('far', 'device')],
  } : d), layout: {
    topology: [at(['a'], 40, 80), at(['b'], 132, 80), at(['c'], 225, 80), at(['d'], 320, 150), at(['far'], 1700, 900)],
    topologyFrames: [{ modulePath: ['a'], x: 0, y: 0, width: 600, height: 240 }],
  } };
  const before = view(project, [], [['c']]);
  const expanded = [['a'], ['c']], opened = new Set([hierarchyKey(['a'])]);
  const edit = planInlineExpansion(view(project, [], expanded), opened);
  assert.deepEqual(edit.moves.map(m => m.instancePath.join('/')).sort(), ['b', 'c', 'd']);
  const after = view(apply(project, edit), [], expanded);
  assertSiblingsClear(after);
  assert.deepEqual(object(after, ['a']).position, object(before, ['a']).position);
  assert.deepEqual(object(after, ['c', 'inside']).position, object(before, ['c', 'inside']).position);
  assert.deepEqual(object(after, ['far']).bounds, object(before, ['far']).bounds);
});

test('a growing branch stays anchored beside a cabinet one pixel higher, including a click from a temporary slot', () => {
  const project = fixture(540, 300);
  project.layout = {
    topology: [at(receiver, 100, 80), at(['other'], 710, 79), at(board, 300, 70), at(['other', 'board'], 300, 70)],
    topologyFrames: [receiver, ['other']].flatMap(path => [
      { modulePath: path, x: 0, y: 0, width: 590, height: 270 },
      { modulePath: [...path, 'board'], x: 0, y: 0, width: 490, height: 320 },
    ]),
  };
  const cabinets = [receiver, ['other']];
  const baseline = projectInlineExpansion(...viewArgs(project, [], cabinets)).view;
  const anchorAt = (view: ReturnType<typeof projectTopology>, paths: InstancePath[]) =>
    new Map(paths.map(path => [hierarchyKey(path), object(view, path).bounds]));
  const open = projectInlineExpansion(...viewArgs(project, [], [...cabinets, board]), anchorAt(baseline, [receiver, board])).view;
  assert.deepEqual(object(open, receiver).position, object(baseline, receiver).position);
  assert.deepEqual(object(open, board).position, object(baseline, board).position);
  assert.notDeepEqual(object(open, ['other']).position, object(baseline, ['other']).position);
  assertSiblingsClear(open);

  const clicked = [['other'], ['other', 'board']];
  const anchors = anchorAt(open, clicked);
  const both = projectInlineExpansion(...viewArgs(project, [], [...cabinets, board, clicked[1]]), anchors).view;
  for (const path of clicked) assert.deepEqual(object(both, path).position, object(open, path).position);
  assertSiblingsClear(both);
  const collapsed = projectInlineExpansion(...viewArgs(project, [], cabinets)).view;
  for (const path of cabinets) assert.deepEqual(displayedBounds(collapsed, path), displayedBounds(baseline, path));
});

test('batch expansion resolves stacked siblings inside both enclosures and propagates growth through a frameless root', () => {
  const source = fixture(420, 225);
  const enclosures = ['receiver', 'other'];
  const boards = ['third', 'second', 'first'];
  const expanded = enclosures.flatMap(id => [[id], ...boards.map(b => [id, b])]);
  const project: Project = { ...source, moduleDefinitions: source.moduleDefinitions.map(d => d.id === 'receiver'
    ? { ...d, instances: boards.map(id => instance(id, 'board')) } : d), layout: {
    topology: enclosures.flatMap((id, i) => [at([id], 100 + 214 * i, 90), ...boards.map(b => at([id, b], 22, 68))]),
    topologyFrames: expanded.map(path => ({ modulePath: path, x: 0, y: 0, width: 420, height: 225 })),
  } };
  const opened = new Set(expanded.map(hierarchyKey));
  const before = view(project, [], expanded);
  assert.equal(before.nodeByKey.has('[]'), false);
  const edit = planInlineExpansion(before, opened);
  const saved = parseProjectJson(serializeProjectJson(apply(project, edit)));
  const after = view(saved, [], expanded);
  assertSiblingsClear(after);
  assert.deepEqual(planInlineExpansion(after, opened), { moves: [], frames: [] });
  assert.deepEqual(object(after, ['receiver']).position, object(before, ['receiver']).position);
  for (const id of enclosures) {
    assert.deepEqual(object(after, [id, 'first']).bounds, object(before, [id, 'first']).bounds);
    assert.ok(edit.frames.some(frame => frame.modulePath.join('/') === id && (frame.width > 420 || frame.height > 225)));
  }
  const reversed = { ...project, moduleDefinitions: project.moduleDefinitions.map(d => ({ ...d, instances: [...d.instances].reverse() })) };
  const reordered = view(apply(reversed, planInlineExpansion(view(reversed, [], expanded), opened)), [], expanded);
  for (const path of expanded) assert.deepEqual(displayedBounds(reordered, path), displayedBounds(after, path));
});

test('a measured port edit retains both the enlarged frame and sibling placements in the edit history and JSON', () => {
  for (const savedFrame of [true, false]) {
    const source = fixture(940, 540);
    const boardDefinition = source.moduleDefinitions.find(d => d.id === 'board')!;
    boardDefinition.ports = [{ id: 'COM', name: 'COM', type: 'OPTICAL', direction: 'bidirectional' }];
    if (!savedFrame) source.layout!.topologyFrames = source.layout!.topologyFrames!.filter(f => f.modulePath.length !== 2);
    const store = createProjectStore(source);
    const initial = store.getSnapshot().project;
    const expanded = [receiver, board];
    const original = view(initial, [], expanded);
    const rename = (draft: Project, name: string) => ({ ...draft, moduleDefinitions: draft.moduleDefinitions.map(d =>
      d.id === 'board' ? { ...d, ports: d.ports.map(p => ({ ...p, name })) } : d) });
    store.commit(draft => rename(draft, 'Tall label'));
    const edited = store.getSnapshot().project;
    const tall = new Map([[hierarchyKey(board), { side: 0, top: 334 }]]);
    const measured = view(edited, [], expanded, tall);
    const edit = planInlineExpansion(measured, key, original);
    const grown = edit.frames.find(frame => hierarchyKey(frame.modulePath) === hierarchyKey(board))!;
    assert.equal(grown.height, object(measured, board).frame!.display.height);
    assert.ok(grown.height > object(original, board).frame!.display.height);
    assert.ok(edit.moves.length);
    assert.equal(store.extendCommit(edited, draft => apply(draft, edit))?.ok, true);
    const saved = parseProjectJson(serializeProjectJson(store.getSnapshot().project));
    assertSiblingsClear(view(saved, [], expanded, tall));
    store.undo();
    assert.equal(store.getSnapshot().project, initial);
    assert.equal(store.getSnapshot().canUndo, false);
    store.redo();
    assert.deepEqual(store.getSnapshot().project, saved);
    store.commit(draft => rename(draft, 'COM'));
    const shortened = store.getSnapshot().project;
    assert.deepEqual(shortened.layout, saved.layout);
    assert.equal(object(view(shortened, [], expanded), board).frame!.display.height, grown.height);
  }
});
