import type { CoordinateExtent, Rect } from '@xyflow/react';
import type { TopologyFrame, TopologyPlacement } from '../../../model/v1/types';
import { keepNodeInside, moduleExtent } from './frame-geometry';
import { frameInsets, framePadding } from './module-frame';
import type { projectTopology } from './topology-projection';

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;
const overlaps = (a: Rect, b: Rect) =>
  a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a);

function nearestSlot(card: Rect, obstacles: readonly Rect[], extent: CoordinateExtent): Rect {
  const [[left, top], [east, south]] = extent;
  let best: Rect | undefined;
  let bestDistance = Infinity;
  let bestFits = false;
  for (const gap of [12, 0]) {
    // A nearest free position touches an obstacle, a boundary, or one of the card's original axes.
    const xs = new Set([card.x, left, east - card.width]);
    const ys = new Set([card.y, top, south - card.height]);
    for (const obstacle of obstacles) {
      xs.add(obstacle.x - card.width - gap).add(right(obstacle) + gap);
      ys.add(obstacle.y - card.height - gap).add(bottom(obstacle) + gap);
    }
    for (const x of xs) {
      if (!Number.isFinite(x) || x < left) continue;
      for (const y of ys) {
        if (!Number.isFinite(y) || y < top) continue;
        const candidate = { ...card, x, y };
        const fits = right(candidate) <= east && bottom(candidate) <= south;
        if (!gap && !fits) continue;
        const distance = (x - card.x) ** 2 + (y - card.y) ** 2;
        if ((bestFits && !fits) || (bestFits === fits && distance >= bestDistance)) continue;
        if (obstacles.some(rect => overlaps(candidate, rect))) continue;
        best = candidate;
        bestFits = fits;
        bestDistance = distance;
      }
    }
    if (bestFits) break;
  }
  return best!;
}

export function planInlineExpansion(projection: ReturnType<typeof projectTopology>, opened: ReadonlySet<string>) {
  const moves: TopologyPlacement[] = [];
  const frames: TopologyFrame[] = [];
  const growing = new Set(opened);
  const resized = new Map<string, Rect>();
  for (const [key, scope] of [...projection.scopes].reverse()) {
    const members = scope.members.map(node => {
      const frame = resized.get(node.key) ?? node.frame?.display;
      const bounds = frame ? { ...node.bounds, width: frame.width, height: frame.height } : node.bounds;
      return { node, bounds };
    });
    const anchors = members.filter(({ node }) => growing.has(node.key)).map(({ bounds }) => bounds);
    if (!anchors.length) continue;

    const owner = projection.nodeByKey.get(key)?.frame;
    const insets = frameInsets(scope.definition.ports, projection.portHeights?.get(key));
    const extent: CoordinateExtent = owner ? moduleExtent(owner.display, insets) : [[-Infinity, -Infinity], [Infinity, Infinity]];
    const moving = new Set(members.filter(({ node, bounds }) =>
      node.item.definition.kind === 'component' && anchors.some(anchor => overlaps(anchor, bounds))));
    const occupied = members.filter(member => !moving.has(member)).map(({ bounds }) => bounds);
    for (const member of moving) {
      member.bounds = nearestSlot(member.bounds, occupied, extent);
      occupied.push(member.bounds);
      moves.push({ instancePath: member.node.item.instancePath, x: member.bounds.x, y: member.bounds.y });
    }

    if (!owner) continue;
    const { x, y } = owner.display;
    const width = Math.max(owner.display.width, ...occupied.map(r => (r.x - x) + r.width + insets.right));
    const height = Math.max(owner.display.height, ...occupied.map(r => (r.y - y) + r.height + framePadding));
    const grew = width > owner.base.width + 1e-6 || height > owner.base.height + 1e-6;
    if (!grew && (owner.saved || !moving.size)) continue;

    // Saving an automatic frame also keeps its origin fixed if a moved card defined its old left/top edge.
    const frame = { x, y, width, height };
    frames.push({ modulePath: scope.path, ...frame });
    resized.set(key, frame);
    if (grew) growing.add(key);
    const nextExtent = moduleExtent(frame, insets);
    for (const member of members) {
      const { node, bounds } = member;
      if (moving.has(member)) continue;
      const next = keepNodeInside({ ...node.bounds, ...node.preferred }, nextExtent);
      if (next.x === bounds.x && next.y === bounds.y) continue;
      moves.push({ instancePath: node.item.instancePath, x: next.x !== bounds.x ? bounds.x : node.preferred.x,
        y: next.y !== bounds.y ? bounds.y : node.preferred.y });
    }
  }
  return { moves, frames };
}
