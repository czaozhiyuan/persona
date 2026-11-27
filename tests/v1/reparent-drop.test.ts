import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameInsets } from '../../src/editors/topology/v1/module-frame';
import { groupDragBounds, groupDragExtent, groupDropDelta, placeDropGroup, reparentDropTarget } from '../../src/editors/topology/v1/reparent-drop';
import type { TopologyItem } from '../../src/editors/topology/v1/topology-projection';

test('the pointer picks the deepest visible module, exactly up to its edge', () => {
  function moduleAt(path: string[], x: number, size: number): TopologyItem {
    const id = path.at(-1)!, position = { x, y: x };
    return { item: { instancePath: path, definition: { id, kind: 'module', name: id, instances: [], ports: [] }, parameters: new Map() },
      key: JSON.stringify(path), bounds: { ...position, width: size, height: size }, position, preferred: position, offset: { x: 0, y: 0 } };
  }
  const source = moduleAt(['source'], 500, 80);
  const outer = moduleAt(['chassis'], 100, 300), inner = moduleAt(['chassis', 'card'], 150, 100);
  const visible = [source, inner, outer];
  const geometry = new Map(visible.map(node => [node.key, node.bounds]));
  const target = (from: TopologyItem, x: number) => reparentDropTarget(from, visible, [], geometry, { x, y: x });
  assert.equal(target(source, 250)?.node, inner);
  assert.equal(target(source, 251)?.node, outer);
  assert.equal(target(outer, 200)?.node, inner);
  assert.deepEqual(target(inner, 450)?.destination, []);
  assert.equal(target(inner, 251), undefined);
});

test('a group drop translates the whole box and grows the saved destination without shifting its origin', () => {
  const box = { x: 80, y: 100, width: 420, height: 130 };
  const anchor = { x: 300, y: 150 };
  const drop = { x: 450, y: 50 };
  const frame = { modulePath: ['target'], x: 0, y: 0, width: 360, height: 120 };
  const insets = frameInsets([]);
  assert.deepEqual(placeDropGroup(box, anchor, drop, frame, insets), {
    delta: { x: 150, y: -40 },
    frame: { ...frame, width: 678, height: 218 },
  });
  assert.deepEqual(placeDropGroup(box, anchor, drop), { delta: { x: 150, y: -100 } });
  assert.deepEqual(placeDropGroup(box, anchor, drop, { ...frame, width: 700, height: 300 }, insets),
    { delta: { x: 150, y: -40 }, frame: undefined });
});

test('group snapping uses the local bounding corner and applies one delta even when the grabbed member is elsewhere', () => {
  const box = { x: 13.5, y: -22, width: 273, height: 100 };
  const grab = { x: 179, y: 27 };
  const position = { x: 194, y: 41 };
  assert.deepEqual(groupDropDelta(box, grab, position), { x: 16.5, y: 12 });
  assert.deepEqual(groupDropDelta(box, grab, position, undefined, true), { x: 15, y: 14 });
  assert.deepEqual(groupDropDelta(box, grab, position, [[14, -21], [290, 82]]), { x: 3.5, y: 2 });
});

test('expanded members use their visible size and cannot make existing source overflow worse', () => {
  const compact = { x: 0, y: 0, width: 202, height: 96 };
  const base = { x: -10, y: -20, width: 360, height: 160 };
  const members = [
    { key: 'a', bounds: compact, frame: { base, display: base, saved: false } },
    { key: 'b', bounds: { ...compact, x: 440 },
      frame: { base, display: { ...base, width: 380, height: 240 }, saved: true } },
  ];
  const expanded = groupDragBounds(members);
  assert.deepEqual(expanded, { x: 0, y: 0, width: 820, height: 240 });

  const source = groupDragExtent(expanded, [[-100, 0], [800, 260]]);
  assert.deepEqual(groupDropDelta(expanded, compact, compact, source), { x: 0, y: 0 });
  assert.deepEqual(groupDropDelta(expanded, compact, { x: 20, y: 40 }, source), { x: 0, y: 20 });
  assert.deepEqual(groupDropDelta(expanded, compact, { x: -20, y: 0 }, source), { x: -20, y: 0 });
});
