import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepGraphVisible } from '../../src/editors/topology/v1/viewport';

test('panning retains visible node content and leaves valid viewports alone', () => {
  const nodes = [{ x: 250, y: 100, width: 150, height: 60 }];
  const fitting = { x: -45, y: 10, zoom: 1.5 };
  assert.equal(keepGraphVisible(fitting, 600, 400, nodes), fitting);
  assert.deepEqual(keepGraphVisible({ x: -900, y: -850, zoom: 1.5 }, 600, 400, nodes),
    { x: -576, y: -216, zoom: 1.5 });
});

test('a corner of a spread-out graph does not count as visible when it contains no nodes', () => {
  const nodes = [{ x: 0, y: 0, width: 100, height: 50 }, { x: 500, y: 500, width: 100, height: 50 }];
  const emptyCorner = { x: -520, y: 0, zoom: 1 };
  assert.deepEqual(keepGraphVisible(emptyCorner, 300, 300, nodes), { x: -520, y: -224, zoom: 1 });
  assert.equal(keepGraphVisible(emptyCorner, 300, 300, []), emptyCorner);
});
