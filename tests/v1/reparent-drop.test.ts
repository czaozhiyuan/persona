import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CoordinateExtent } from '@xyflow/react';
import { fitsDropExtent, groupDropDelta } from '../../src/editors/topology/v1/reparent-drop';

test('a group drop translates the whole box into the destination and rejects an undersized frame', () => {
  const box = { x: 80, y: 100, width: 420, height: 130 };
  const anchor = { x: 300, y: 150 };
  const drop = { x: 450, y: 50 };
  const frame: CoordinateExtent = [[20, 50], [480, 300]];
  assert.equal(fitsDropExtent(box, frame), true);
  assert.equal(fitsDropExtent(box, [[20, 50], [430, 300]]), false);
  assert.equal(fitsDropExtent(box, [[20, 50], [480, 160]]), false);
  assert.deepEqual(groupDropDelta(box, anchor, drop, frame), { x: -20, y: -50 });
  assert.deepEqual(groupDropDelta(box, anchor, drop), { x: 150, y: -100 });
});
