import { getNodesBounds } from '@xyflow/react';
import type { CoordinateExtent, Rect, XYPosition } from '@xyflow/react';
import type { planInstanceMoves } from '../../../state/v1/reparent-instance';
import type { TopologyFrame, TopologyPlacement } from '../../../model/v1/types';
import { gridCoordinate } from '../../../state/v1/topology-grid';
import { moduleExtent } from './frame-geometry';
import { hierarchyKey, inHierarchy } from './hierarchy-view';
import { frameInsets, framePadding } from './module-frame';
import type { TopologyItem } from './topology-projection';

export type ApprovedMove = Extract<ReturnType<typeof planInstanceMoves>, { ok: true }>;

export type ReparentLayout = { placements: readonly TopologyPlacement[]; delta: XYPosition; frame?: TopologyFrame };

type DropTarget = {
  kind: 'in' | 'up';
  node: TopologyItem | undefined;
  destination: readonly string[];
  problem?: string;
};

function contains(rect: Rect, point: XYPosition) {
  return point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height;
}

export function reparentDropTarget(source: TopologyItem, nodes: readonly TopologyItem[], rootPath: readonly string[],
  bounds: ReadonlyMap<string, Rect>, point: XYPosition): DropTarget | undefined {
  const parentPath = source.item.instancePath.slice(0, -1);
  let hit: TopologyItem | undefined;
  for (const node of nodes) {
    const rect = bounds.get(node.key);
    if (!rect || !contains(rect, point)) continue;
    const depth = node.item.instancePath.length;
    // On the same level compact cards are drawn above frames, then later siblings above earlier ones.
    if (!hit || depth > hit.item.instancePath.length
      || (depth === hit.item.instancePath.length && (!node.frame || hit.frame))) hit = node;
  }

  const destination = hit?.item.instancePath ?? rootPath;
  if (!hit && bounds.has(hierarchyKey(rootPath))) {
    return { kind: 'up', node: nodes.find(node => node.key === hierarchyKey(rootPath)), destination,
      problem: rootPath.length ? '请在当前模块边框内放置，或在上一级展开模块后拖出。' : '请在顶层模块边框内放置。' };
  }
  if (hierarchyKey(destination) === hierarchyKey(parentPath)) return;
  return { kind: inHierarchy(destination, parentPath) ? 'up' : 'in', node: hit, destination };
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
  frame?: TopologyFrame, insets?: ReturnType<typeof frameInsets>, free = false) {
  const delta = groupDropDelta(bounds, anchor, position, frame && insets ? [moduleExtent(frame, insets)[0], [Infinity, Infinity]] : undefined, free);
  if (!frame || !insets) return { delta };
  // Keep the saved origin and translate all members together before growing the far edges.
  const width = Math.max(frame.width, bounds.x + delta.x + bounds.width + insets.right - frame.x);
  const height = Math.max(frame.height, bounds.y + delta.y + bounds.height + framePadding - frame.y);
  return { delta, frame: width === frame.width && height === frame.height ? undefined : { ...frame, width, height } };
}

export function groupDropDelta(bounds: Rect, anchor: XYPosition, position: XYPosition, extent?: CoordinateExtent, free = false): XYPosition {
  const [[left, top], [right, bottom]] = extent ?? [[-Infinity, -Infinity], [Infinity, Infinity]];
  return {
    x: gridCoordinate(bounds.x + position.x - anchor.x, free, left, right - bounds.width) - bounds.x,
    y: gridCoordinate(bounds.y + position.y - anchor.y, free, top, bottom - bounds.height) - bounds.y,
  };
}
