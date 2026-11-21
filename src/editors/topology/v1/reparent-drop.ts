import type { Rect, XYPosition } from '@xyflow/react';
import { planInstanceMove } from '../../../state/v1/reparent-instance';
import { hierarchyKey, inHierarchy } from './hierarchy-view';
import { frameHeader, frameInsets, framePadding } from './module-frame';
import type { TopologyItem } from './topology-projection';

export type ApprovedMove = Extract<ReturnType<typeof planInstanceMove>, { ok: true }>;

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
  const insets = frameInsets(node.item.definition.ports);
  return { x: bounds.x + insets.left, y: bounds.y + frameHeader,
    width: bounds.width - insets.left - insets.right, height: bounds.height - frameHeader - framePadding };
}

export function reparentDropTarget(source: TopologyItem, nodes: readonly TopologyItem[], rootPath: readonly string[],
  boundsOf: (node: TopologyItem) => Rect | undefined, point: XYPosition, edgeMargin: number): DropTarget | undefined {
  const path = source.item.instancePath;
  const parentPath = path.slice(0, -1);
  const parentKey = hierarchyKey(parentPath);
  const parent = nodes.find(node => node.key === parentKey);
  const parentBounds = parent && boundsOf(parent);
  if (!parentBounds || contains(parentBounds, point, edgeMargin)) {
    const siblings = nodes.filter(node => node.key !== source.key && node.item.definition.kind === 'module'
      && node.item.instancePath.length === path.length && inHierarchy(parentPath, node.item.instancePath));
    for (const node of siblings.reverse()) {
      const bounds = boundsOf(node);
      if (bounds && contains(moduleBody(node, bounds), point)) return { kind: 'in', node, destination: node.item.instancePath };
    }
    return;
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
