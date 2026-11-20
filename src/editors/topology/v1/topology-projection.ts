import type { Rect, XYPosition } from '@xyflow/react';
import type { ResolvedInstance } from '../../../engine/v1/hierarchy';
import type { InstancePath, ModuleDefinition, Project } from '../../../model/v1/types';
import { blockPortRows } from './block-ports';
import { fitModuleFrame, keepNodeInside, minimumFrame, moduleExtent } from './frame-geometry';
import { hierarchyChildren, hierarchyKey } from './hierarchy-view';
import { frameInsets, framePadding } from './module-frame';

type Size = { width: number; height: number };
type Frame = { base: Rect; display: Rect; saved: boolean };
export type TopologyItem = {
  item: ResolvedInstance;
  key: string;
  parentKey?: string;
  bounds: Rect;
  preferred: XYPosition;
  offset: XYPosition;
  position: XYPosition;
  frame?: Frame;
};

export const toLocalPosition = (position: XYPosition, offset: XYPosition): XYPosition =>
  ({ x: position.x + offset.x, y: position.y + offset.y });

export function projectTopology(project: Project, instances: readonly ResolvedInstance[], scope: InstancePath,
  expanded: ReadonlySet<string>, measured: ReadonlyMap<string, Size>, resizePreview?: Rect) {
  const rootKey = hierarchyKey(scope);
  const root = instances.find(item => hierarchyKey(item.instancePath) === rootKey)!;
  const children = hierarchyChildren(instances);
  const positions = new Map(project.layout?.topology?.map(item => [hierarchyKey(item.instancePath), item]));
  const frames = new Map(project.layout?.topologyFrames?.map(frame => [hierarchyKey(frame.modulePath), frame]));
  const pending = [{ item: root, key: rootKey }];
  const nodes: TopologyItem[] = [];
  const nodeByKey = new Map<string, TopologyItem>();
  const scopes = new Map<string, { definition: ModuleDefinition; path: InstancePath; members: TopologyItem[] }>();

  while (pending.length) {
    const { item, key } = pending.pop()!;
    const isRoot = key === rootKey;
    const current = nodeByKey.get(key);
    if (current) nodes.push(current);
    if (item.definition.kind !== 'module' || (!isRoot && !expanded.has(key))) continue;

    const ports = item.definition.ports;
    const insets = frameInsets(ports);
    const saved = frames.get(key);
    const ownChildren = (children.get(key) ?? []).map((child, index): TopologyItem => {
      const childKey = hierarchyKey(child.instancePath);
      const placement = positions.get(childKey);
      const preferred = placement ? { x: placement.x, y: placement.y }
        : { x: 260 * (index % 3) + (ports.length ? 260 : 25), y: 240 * Math.floor(index / 3) + 25 };
      const size = measured.get(childKey) ?? { width: 202, height: 48 + blockPortRows(child.definition.ports) * 24 };
      return { item: child, key: childKey, bounds: { ...preferred, ...size }, preferred, position: preferred, offset: { x: 0, y: 0 } };
    });

    if (!isRoot || scope.length || ports.length || saved) {
      const compact = ownChildren.map(child => child.bounds);
      const min = minimumFrame(compact, insets);
      const base = saved
        ? { x: saved.x, y: saved.y, width: Math.max(saved.width, min.width), height: Math.max(saved.height, min.height) }
        : fitModuleFrame(compact, insets);
      const display = { ...(isRoot && resizePreview ? resizePreview : base) };
      const frame = { base, display, saved: !!saved };
      if (current) current.frame = frame;
      else {
        const boundary = { item, key, bounds: base, preferred: base, position: display, offset: { x: 0, y: 0 }, frame };
        nodes.push(boundary);
        nodeByKey.set(key, boundary);
      }
      const extent = moduleExtent(base, insets);
      for (const child of ownChildren) {
        const position = keepNodeInside(child.bounds, extent);
        child.bounds = { ...child.bounds, ...position };
        child.parentKey = key;
        child.offset = display;
        child.position = { x: position.x - display.x, y: position.y - display.y };
      }
    }

    scopes.set(key, { definition: item.definition, path: item.instancePath, members: ownChildren });
    for (let index = ownChildren.length - 1; index >= 0; index--) {
      const child = ownChildren[index];
      nodeByKey.set(child.key, child);
      pending.push(child);
    }
  }

  // An inline frame grows to display expanded descendants. Compact positions and saved frame geometry stay intact.
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (!node.frame || !node.parentKey) continue;
    const parent = nodeByKey.get(node.parentKey)!;
    const display = parent.frame!.display;
    const insets = frameInsets(parent.item.definition.ports);
    display.width = Math.max(display.width, node.position.x + node.frame.display.width + insets.right);
    display.height = Math.max(display.height, node.position.y + node.frame.display.height + framePadding);
  }

  return { rootKey, nodes, nodeByKey, scopes };
}
