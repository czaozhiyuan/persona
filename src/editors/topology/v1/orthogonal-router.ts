import type { Rect } from '@xyflow/react';
import type { RoutePoint as Point } from '../../../model/v1/types';
import { gridPoint, topologyGrid as step } from '../../../state/v1/topology-grid';

export type PortSide = 'left' | 'right' | 'top' | 'bottom';
export type RoutingPort = Point & { side: PortSide; obstacle: string };
export type RoutingWire = { id: string; source: RoutingPort; target: RoutingPort };
export type RoutingObstacle = Rect & { id: string };
export type RoutingScene = { obstacles: readonly RoutingObstacle[]; boundary?: Rect; wires: readonly RoutingWire[] };
export const wireCornerRadius = 8;
const directions = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
const directionIndex = { right: 0, bottom: 1, left: 2, top: 3 };
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const advance = (p: Point, d: number, amount: number): Point =>
  ({ x: p.x + directions[d].x * amount, y: p.y + directions[d].y * amount });

function inside(p: Point, r?: Rect) {
  return !r || p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;
}

// Test the entire segment, or the convex hull of a connector/corner inside its bounding box.
function overlaps(a: Point, b: Point, r: Rect, padding: number) {
  return Math.max(a.x, b.x) > r.x - padding && Math.min(a.x, b.x) < r.x + r.width + padding
    && Math.max(a.y, b.y) > r.y - padding && Math.min(a.y, b.y) < r.y + r.height + padding;
}

// Typical grid edges touch one or two buckets. Huge rectangles stay in one shared list.
function indexObstacles(obstacles: readonly RoutingObstacle[]) {
  const size = 120;
  const buckets = new Map<string, RoutingObstacle[]>(), wide: RoutingObstacle[] = [];
  const key = (x: number, y: number) => x + ',' + y;
  for (const r of obstacles) {
    const x0 = Math.floor(r.x / size), x1 = Math.floor((r.x + r.width) / size);
    const y0 = Math.floor(r.y / size), y1 = Math.floor((r.y + r.height) / size);
    if (![x0, x1, y0, y1].every(Number.isSafeInteger) || (x1 - x0 + 1) * (y1 - y0 + 1) > 64) { wide.push(r); continue; }
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const id = key(x, y);
      const list = buckets.get(id);
      if (list) list.push(r); else buckets.set(id, [r]);
    }
  }
  return (a: Point, b: Point, pad: number, except?: string) => {
    const hit = (r: RoutingObstacle) => r.id !== except && overlaps(a, b, r, pad);
    const x0 = Math.floor((Math.min(a.x, b.x) - pad) / size), x1 = Math.floor((Math.max(a.x, b.x) + pad) / size);
    const y0 = Math.floor((Math.min(a.y, b.y) - pad) / size), y1 = Math.floor((Math.max(a.y, b.y) + pad) / size);
    if (![x0, x1, y0, y1].every(Number.isSafeInteger) || (x1 - x0 + 1) * (y1 - y0 + 1) > 64) return obstacles.some(hit);
    if (wide.some(hit)) return true;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      if (buckets.get(key(x, y))?.some(hit)) return true;
    }
    return false;
  };
}

function laneKey(a: Point, b: Point) {
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), a.x === b.x ? 'v' : 'h'].join(',');
}

type Visit = Point & { dir: number; cost: number; score: number; previous?: Visit };
const before = (a: Visit, b: Visit) => a.score < b.score || a.score === b.score && a.cost > b.cost;

class Frontier {
  entries: Visit[] = [];
  push(node: Visit) {
    const heap = this.entries;
    let index = heap.length;
    heap.push(node);
    while (index) {
      const parent = (index - 1) >> 1;
      if (!before(node, heap[parent])) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = node;
  }
  pop(): Visit {
    const heap = this.entries;
    const result = heap[0], tail = heap.pop()!;
    if (heap.length) {
      let index = 0;
      while (2 * index + 1 < heap.length) {
        let child = 2 * index + 1;
        if (child + 1 < heap.length && before(heap[child + 1], heap[child])) child++;
        if (!before(heap[child], tail)) break;
        heap[index] = heap[child];
        index = child;
      }
      heap[index] = tail;
    }
    return result;
  }
}

function simplify(points: readonly Point[]) {
  const result: Point[] = [];
  for (const p of points) {
    const last = result.at(-1), previous = result.at(-2);
    if (last && !distance(last, p)) continue;
    if (previous && last && (previous.x === last.x && last.x === p.x || previous.y === last.y && last.y === p.y)) result.pop();
    result.push({ x: p.x, y: p.y });
  }
  return result;
}

type SearchSpace = {
  boundary?: Rect; byId: Map<string, RoutingObstacle>; blocked: ReturnType<typeof indexObstacles>;
  lanes: Map<string, number>; remaining: number;
};

function routeWire(wire: RoutingWire, space: SearchSpace, clearance: number) {
  const { boundary, lanes } = space;
  const clear = (a: Point, b: Point, pad: number, except?: string) =>
    inside(b, boundary) && !space.blocked(a, b, pad, except);
  function escape(port: RoutingPort) {
    const dir = directionIndex[port.side];
    const r = space.byId.get(port.obstacle);
    const edge = r ? [r.x + r.width - port.x, r.y + r.height - port.y, port.x - r.x, port.y - r.y][dir] : 0;
    const anchor = gridPoint(advance(port, dir, Math.max(0, edge) + clearance + step / 2));
    // The port and its two cubic controls are all inside this box at planning time.
    if (!inside(port, boundary) || !clear(port, anchor, 1, port.obstacle) || !clear(anchor, anchor, clearance)) return;
    return { anchor, dir };
  }
  const from = escape(wire.source), to = escape(wire.target);
  if (!from || !to || !distance(from.anchor, to.anchor)) return;
  const start = from.anchor, end = to.anchor;
  if (!clear(start, advance(start, from.dir, step), clearance) || !clear(end, advance(end, to.dir, step), clearance)) return;
  const key = (p: Point, dir: number) => [p.x, p.y, dir].join(',');
  const frontier = new Frontier();
  frontier.push({ ...start, dir: from.dir, cost: 0, score: distance(start, end) });
  const costs = new Map([[key(start, from.dir), 0]]);
  let visits = 0;
  while (frontier.entries.length && visits++ < 7000 && space.remaining-- > 0) {
    const p = frontier.pop();
    if (p.cost !== costs.get(key(p, p.dir))) continue;
    if (!distance(p, end) && p.dir === (to.dir + 2) % 4) {
      const points: Point[] = [];
      for (let v: Visit | undefined = p; v; v = v.previous) points.push(v);
      points.reverse();
      for (let i = 1; i < points.length; i++) {
        const lane = laneKey(points[i - 1], points[i]);
        lanes.set(lane, (lanes.get(lane) ?? 0) + 1);
      }
      return simplify(points);
    }
    for (let d = 0; d < 4; d++) {
      if (d === (p.dir + 2) % 4 || (!p.previous && d !== from.dir)) continue;
      const next = advance(p, d, step);
      if (!distance(next, start) || (!distance(next, end) && d !== (to.dir + 2) % 4)) continue;
      if (!clear(p, next, clearance)) continue;
      if (p.dir !== d && !clear(advance(p, p.dir, -wireCornerRadius), advance(p, d, wireCornerRadius), 1)) continue;
      const cost = p.cost + step + (p.dir === d ? 0 : 14) + 30 * (lanes.get(laneKey(p, next)) ?? 0);
      const id = key(next, d);
      if (cost >= (costs.get(id) ?? Infinity)) continue;
      costs.set(id, cost);
      frontier.push({ ...next, dir: d, cost, score: cost + distance(next, end), previous: p });
    }
  }
}

/** All geometry is in the owning module's local coordinates. Missing IDs retain their previous paths. */
export function planOrthogonalRoutes(scene: RoutingScene) {
  const routes = new Map<string, readonly Point[]>();
  const space: SearchSpace = { boundary: scene.boundary, byId: new Map(scene.obstacles.map(r => [r.id, r])),
    blocked: indexObstacles(scene.obstacles), lanes: new Map(), remaining: 100_000 };
  for (const wire of [...scene.wires].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (space.remaining <= 0) break;
    for (const clearance of [17, 2]) {
      const points = routeWire(wire, space, clearance);
      if (points) { routes.set(wire.id, points); break; }
    }
  }
  return routes;
}
