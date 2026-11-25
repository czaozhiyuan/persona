import { getNodesBounds } from '@xyflow/react';
import type { CoordinateExtent, Rect, XYPosition } from '@xyflow/react';
import type { planInstanceMoves } from '../../../state/v1/reparent-instance';
import type { TopologyFrame, TopologyPlacement } from '../../../model/v1/types';
import { keepNodeInside, moduleExtent } from './frame-geometry';
import { hierarchyKey, inHierarchy } from './hierarchy-view';
import { frameInsets, framePadding } from './module-frame';
import type { TopologyItem } from './topology-projection';

export type ApprovedMove = Extract<ReturnType<typeof planInstanceMoves>, { ok: true }>;

export type ReparentLayout = { placements: readonly TopologyPlacement[]; frame?: TopologyFrame };

type DropTarget = {
  kind: 'in' | 'up';
  node: TopologyItem | undefined;
  destination: readonly string[];
  problem?: string;
};

function contains(rect: Rect, point: XYPosition, margin = 0) {
  return point.x >= rect.x - margin && point.x <= rect.x + rect.width + margin
    && point.y >= rect.y - margin && point.y <= rect.y + rect.height + margin;
}

function moduleBody(node: TopologyItem, bounds: Rect): Rect {
  if (!node.frame) return bounds;
  const insets = node.frame.insets;
  return { x: bounds.x + insets.left, y: bounds.y + insets.top,
    width: bounds.width - insets.left - insets.right, height: bounds.height - insets.top - framePadding };
}

export function reparentDropTarget(source: TopologyItem, nodes: readonly TopologyItem[], rootPath: readonly string[],
  boundsOf: (node: TopologyItem) => Rect | undefined, point: XYPosition, edgeMargin: number, movingKeys: ReadonlySet<string>): DropTarget | undefined {
  const path = source.item.instancePath;
  const parentPath = path.slice(0, -1);
  const parentKey = hierarchyKey(parentPath);
  const parent = nodes.find(node => node.key === parentKey);
  const parentBounds = parent && boundsOf(parent);
  if (!parentBounds || contains(parentBounds, point, edgeMargin)) {
    const siblings = nodes.filter(node => !movingKeys.has(node.key) && node.item.definition.kind === 'module'
      && node.item.instancePath.length === path.length && inHierarchy(parentPath, node.item.instancePath));
    let nearby: DropTarget | undefined;
    // Collapsed blocks sit above expanded frames. Prefer exact hits before the edge margin.
    for (const node of siblings.reverse().sort((a, b) => Number(!!a.frame) - Number(!!b.frame))) {
      const bounds = boundsOf(node);
      if (!bounds) continue;
      const target = { kind: 'in' as const, node, destination: node.item.instancePath };
      if (contains(bounds, point)) return target;
      if (!nearby && contains(bounds, point, edgeMargin)) nearby = target;
    }
    return nearby;
  }
  if (parentPath.length <= rootPath.length) {
    return { kind: 'up', node: parent, destination: parentPath, problem: parentPath.length ? '请使用「移到上一级」，或在上一级展开模块后拖出。' : '请在顶层模块边框内放置。' };
  }

  const destination = parentPath.slice(0, -1);
  const grandparent = nodes.find(node => node.key === hierarchyKey(destination));
  const outer = grandparent && boundsOf(grandparent);
  if (outer && !contains(moduleBody(grandparent, outer), point)) {
    return { kind: 'up', node: grandparent, destination, problem: '请拖到直接上一级模块的可用区域。' };
  }
  return { kind: 'up', node: grandparent, destination };
}

export function groupDragBounds(items: readonly { key: string; bounds: Rect; frame?: { display: Rect } }[]): Rect {
  return getNodesBounds(items.map(item => ({
    id: item.key, position: item.bounds, measured: item.frame?.display ?? item.bounds, data: {},
  })));
}

export function groupDragExtent(bounds: Rect, [[left, top], [right, bottom]]: CoordinateExtent): CoordinateExtent {
  // An already expanded group may extend beyond the saved parent frame. Do not jump or allow further overflow.
  return [
    [Math.min(left, bounds.x), Math.min(top, bounds.y)],
    [Math.max(right, bounds.x + bounds.width), Math.max(bottom, bounds.y + bounds.height)],
  ];
}

export function placeDropGroup(bounds: Rect, anchor: XYPosition, position: XYPosition,
  frame?: TopologyFrame, insets?: ReturnType<typeof frameInsets>) {
  const delta = { x: position.x - anchor.x, y: position.y - anchor.y };
  if (!frame || !insets) return { delta };
  // Keep the saved origin and translate all members together before growing the far edges.
  const [[left, top]] = moduleExtent(frame, insets);
  delta.x = Math.max(delta.x, left - bounds.x);
  delta.y = Math.max(delta.y, top - bounds.y);
  const width = Math.max(frame.width, bounds.x + delta.x + bounds.width + insets.right - frame.x);
  const height = Math.max(frame.height, bounds.y + delta.y + bounds.height + framePadding - frame.y);
  return { delta, frame: width === frame.width && height === frame.height ? undefined : { ...frame, width, height } };
}

export function groupDropDelta(bounds: Rect, anchor: XYPosition, position: XYPosition, extent?: CoordinateExtent): XYPosition {
  const delta = { x: position.x - anchor.x, y: position.y - anchor.y };
  if (!extent) return delta;
  const placed = keepNodeInside({ ...bounds, x: bounds.x + delta.x, y: bounds.y + delta.y }, extent);
  return { x: placed.x - bounds.x, y: placed.y - bounds.y };
}
