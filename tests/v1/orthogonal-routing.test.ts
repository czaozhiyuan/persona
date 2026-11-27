import assert from 'node:assert/strict';
import test from 'node:test';
import { Position } from '@xyflow/react';
import { fixedWirePath } from '../../src/editors/topology/v1/signal-wire';
import { planOrthogonalRoutes, type RoutingScene, type RoutingWire } from '../../src/editors/topology/v1/orthogonal-router';

const first: RoutingWire = {
  id: 'a', source: { x: 83.5, y: 100, side: 'right', obstacle: 'source' },
  target: { x: 480, y: 100, side: 'left', obstacle: 'target' },
};
const scene: RoutingScene = {
  wires: [first],
  obstacles: [
    { id: 'source', x: 0, y: 40, width: 84, height: 120 },
    { id: 'target', x: 480, y: 40, width: 70, height: 120 },
    { id: 'block', x: 190, y: 75, width: 160, height: 50 },
  ],
};

test('stable separate tracks route around measured rectangles, including a wire in the opposite direction', () => {
  const reversed: RoutingWire = { id: 'c', source: first.target, target: first.source };
  const wires = [first, { ...first, id: 'b' }, reversed];
  const result = planOrthogonalRoutes({ ...scene, wires });
  assert.deepEqual(result, planOrthogonalRoutes({ ...scene, wires: [...wires].reverse() }));
  assert.equal(result.size, 3);
  const tracks = new Set<number>();
  for (const points of result.values()) {
    for (const [i, p] of points.entries()) {
      assert.equal(p.x % 10, 0); assert.equal(p.y % 10, 0);
      if (!i) continue;
      const previous = points[i - 1];
      assert.notEqual(previous.x === p.x, previous.y === p.y);
      if (Math.max(previous.x, p.x) > 270 && Math.min(previous.x, p.x) < 270) {
        assert.ok(p.y <= 58 || p.y >= 142); tracks.add(p.y);
      }
    }
  }
  assert.equal(tracks.size, 3);
});

test('a narrow channel relaxes clearance, while an obstructed port and a separated frame fail independently', () => {
  const tight = { wires: [first, { ...first, id: 'blocked', source: { ...first.source, x: 220, y: 115 } }],
    boundary: { x: 0, y: 0, width: 600, height: 200 }, obstacles: [scene.obstacles[0], scene.obstacles[1],
      { id: 'north', x: 180, y: 0, width: 160, height: 95 }, { id: 'south', x: 180, y: 105, width: 160, height: 95 }] };
  const routes = planOrthogonalRoutes(tight);
  assert.equal(routes.size, 1);
  assert.deepEqual(routes.get('a')?.map(p => p.y), [100, 100]);
  const solid = [...tight.obstacles, { id: 'wall', x: 260, y: 0, width: 20, height: 200 }];
  assert.equal(planOrthogonalRoutes({ ...tight, obstacles: solid }).size, 0);
});

test('ordinary A* keeps its four-bend detour and a longer search can retry at the same clearance', () => {
  for (const [span, bends] of [[500, 4], [700, 6]]) {
    const wall = { id: 'wall', x: span / 2, y: -200, width: 50, height: span + 240 };
    const wire: RoutingWire = { id: 'a',
      source: { x: 0, y: 0, side: 'left', obstacle: 'source' },
      target: { x: span, y: span, side: 'right', obstacle: 'target' } };
    const routes = planOrthogonalRoutes({ wires: [wire], obstacles: [wall,
      { id: 'source', x: 0, y: -30, width: 60, height: 60 },
      { id: 'target', x: span - 60, y: span - 30, width: 60, height: 60 }] });
    const points = routes.get('a');
    assert.ok(points);
    assert.equal(points.length - 2, bends);
    assert.deepEqual(points[0], { x: -20, y: 0 });
    assert.deepEqual(points.at(-1), { x: span + 20, y: span });
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      assert.ok(Math.max(a.x, b.x) <= wall.x - 17 || Math.min(a.x, b.x) >= wall.x + wall.width + 17
        || Math.max(a.y, b.y) <= wall.y - 17 || Math.min(a.y, b.y) >= wall.y + wall.height + 17);
    }
  }
});

test('failed ordinary and weighted searches share the layer budget across wires and clearances', () => {
  const boundary = { x: 0, y: 0, width: 4000, height: 3000 };
  const obstacles = [{ id: 'wall', x: 1000, y: 0, width: 50, height: 3000 }];
  const deadEnd: RoutingWire = { id: 'a',
    source: { x: 80, y: 1500, side: 'right', obstacle: 'source' },
    target: { x: 2000, y: 1500, side: 'left', obstacle: 'target' } };
  const easy = { ...deadEnd, id: 'z', target: { ...deadEnd.target, x: 300 } };
  const wires = ['a', 'b', 'c'].map(id => ({ ...deadEnd, id }));
  assert.ok(planOrthogonalRoutes({ boundary, obstacles, wires: [easy] }).has('z'));
  assert.equal(planOrthogonalRoutes({ boundary, obstacles, wires: [...wires, easy] }).size, 0);
});

test('fixed corners use limited radii and only the two connector cubics respond to moving top/bottom handles', () => {
  const points = [{ x: 30, y: 50 }, { x: 30, y: 40 }, { x: 150, y: 40 }, { x: 150, y: 20 }];
  const ends = { sourceX: 31, sourceY: 75, targetX: 150, targetY: 2, sourcePosition: Position.Top, targetPosition: Position.Bottom };
  const original = fixedWirePath(ends, points);
  assert.match(original, /A 5,5 0 0 1/); assert.match(original, /A 8,8 0 0 0/);
  const fixed = (d: string) => d.slice(d.indexOf(' L '), d.lastIndexOf(' C '));
  for (const y of [115, 25, 105, 75]) {
    const d = fixedWirePath({ ...ends, sourceY: y }, points);
    assert.equal(fixed(d), fixed(original)); assert.equal(d.split(' C ').length, 3);
    if (y === 75) assert.equal(d, original);
  }
});
