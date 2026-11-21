import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupDragBounds, groupDragExtent, groupDropDelta, placeDropGroup } from '../../src/editors/topology/v1/reparent-drop';

test('a group drop translates the whole box and grows the saved destination without shifting its origin', () => {
  const box = { x: 80, y: 100, width: 420, height: 130 };
  const anchor = { x: 300, y: 150 };
  const drop = { x: 450, y: 50 };
  const frame = { modulePath: ['target'], x: 0, y: 0, width: 360, height: 120 };
  const insets = { left: 28, right: 28, height: 108 };
  assert.deepEqual(placeDropGroup(box, anchor, drop, frame, insets), {
    delta: { x: 150, y: -48 },
    frame: { ...frame, width: 678, height: 210 },
  });
  assert.deepEqual(placeDropGroup(box, anchor, drop), { delta: { x: 150, y: -100 } });
  assert.deepEqual(placeDropGroup(box, anchor, drop, { ...frame, width: 700, height: 300 }, insets),
    { delta: { x: 150, y: -48 }, frame: undefined });
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
