import type { LibraryConfig } from '../../../library/v1/user-library';
import type { Rect, XYPosition } from '@xyflow/react';
import { resolveHierarchy } from '../../../engine/v1/hierarchy';
import { insertLibraryItem } from '../../../library/v1/insert-library-item';
import type { LibraryItem } from '../../../library/v1/insert-library-item';
import type { InstancePath, PortDefinition, Project, TopologyPlacement } from '../../../model/v1/types';
import { moveTopologyNode, moveTopologyNodes, resizeTopologyFrame } from '../../../state/v1/topology-edits';
import { defaultTopologyPosition } from '../../../state/v1/topology-position';
import { outermostPaths } from '../../../state/v1/object-selection';
import { pasteTopologyObjects } from '../../../state/v1/instantiate-module';
import { hierarchyKey } from './hierarchy-view';
import { frameInsets, framePadding } from './module-frame';
import { groupDragBounds, placeDropGroup } from './reparent-drop';
import { estimatedBlockSize, projectTopology } from './topology-projection';

export type Projection = ReturnType<typeof projectTopology>;

export function captureTopologyObjects(project: Project, paths: readonly InstancePath[], view: Projection) {
  const roots = outermostPaths(paths.filter(path => path.length && hierarchyKey(path) !== view.rootKey));
  if (!roots.length) throw new Error('请先选择要复制的器件或模块。');
  const objects = roots.map(path => {
    const key = hierarchyKey(path);
    const node = view.nodeByKey.get(key);
    if (!node) throw new Error('所选对象在当前画布不可见，请重新选择。');
    let { x, y } = node.position;
    let parentKey = node.parentKey;
    while (parentKey !== undefined) {
      const parent = view.nodeByKey.get(parentKey)!;
      x += parent.position.x;
      y += parent.position.y;
      parentKey = parent.parentKey;
    }
    const { width, height } = node.frame?.display ?? node.bounds;
    return { path, key, bounds: { x, y, width, height }, parentOrigin: { x: x - node.bounds.x, y: y - node.bounds.y } };
  });
  return { project, objects, bounds: groupDragBounds(objects) };
}

export type ObjectClipboard = ReturnType<typeof captureTopologyObjects>;

export function pasteInView(project: Project, clipboard: ObjectClipboard, destination: InstancePath, ids: readonly string[],
  position: XYPosition, view: Projection, nextId: () => string) {
  const delta = { x: position.x - clipboard.bounds.x, y: position.y - clipboard.bounds.y };
  const roots = clipboard.objects.map(({ path, bounds, parentOrigin }, i) => ({
    path, id: ids[i], position: { x: bounds.x + delta.x, y: bounds.y + delta.y },
    routeOffset: { x: parentOrigin.x + delta.x, y: parentOrigin.y + delta.y },
  }));
  const copied = pasteTopologyObjects(project, clipboard.project, roots, destination, nextId);
  return growFrameToFit(copied, { ...clipboard.bounds, ...position }, view);
}

export function preserveDeletionLayout(project: Project, parentIds: ReadonlySet<string>, before: Projection,
  scope: InstancePath, expanded: ReadonlySet<string>, measured: Parameters<typeof projectTopology>[4]): Project {
  const affected = new Set<string>();
  for (const { definition, path } of before.scopes.values()) {
    if (!parentIds.has(definition.id)) continue;
    for (let depth = scope.length; depth <= path.length; depth++) {
      affected.add(hierarchyKey(path.slice(0, depth)));
    }
  }
  if (!affected.size) return project;

  const instances = [...resolveHierarchy(project).walkInstances()];
  const after = projectTopology(project, instances, scope, expanded, measured, undefined, before.portHeights);
  let preserved = project;
  for (const key of affected) {
    const node = before.nodeByKey.get(key);
    const frame = node?.frame?.display;
    const next = after.nodeByKey.get(key)?.frame?.display;
    if (frame && next && (frame.x !== next.x || frame.y !== next.y || frame.width !== next.width || frame.height !== next.height)) {
      preserved = resizeTopologyFrame(preserved, { modulePath: node.item.instancePath, ...frame });
    }
  }

  // New frame bounds may expose a previously clamped position. Deleting an earlier child can also shift default slots.
  const final = preserved === project ? after : projectTopology(preserved, instances, scope, expanded, measured, undefined, before.portHeights);
  const moves: TopologyPlacement[] = [];
  for (const key of affected) {
    for (const child of before.scopes.get(key)?.members ?? []) {
      const { x, y } = child.bounds;
      const next = final.nodeByKey.get(child.key)?.bounds;
      if (next && (x !== next.x || y !== next.y)) moves.push({ instancePath: child.item.instancePath, x, y });
    }
  }
  return moveTopologyNodes(preserved, moves);
}

export type CenterPlacement = (definition: { ports: readonly PortDefinition[] }, name: string) => {
  position: XYPosition; projection: Projection;
} | undefined;

function growFrameToFit(project: Project, bounds: Rect, view: Projection) {
  let result = project;
  const root = view.nodeByKey.get(view.rootKey);
  if (!root?.frame) return result;

  const frame = root.frame.display;
  const insets = root.frame.insets;
  const x = Math.min(frame.x, bounds.x - insets.left);
  const y = Math.min(frame.y, bounds.y - insets.top);
  const width = Math.max(frame.x + frame.width, bounds.x + bounds.width + insets.right) - x;
  const height = Math.max(frame.y + frame.height, bounds.y + bounds.height + framePadding) - y;
  const base = root.frame.base;
  if (root.frame.saved && x === base.x && y === base.y && width === base.width && height === base.height) return result;

  // Growing the frame can release a previously clamped child. Keep its visible location.
  const pinned = view.scopes.get(view.rootKey)!.members.flatMap(({ preferred, bounds, item }) =>
    preferred.x === bounds.x && preferred.y === bounds.y ? [] : [{ instancePath: item.instancePath, x: bounds.x, y: bounds.y }]);
  result = moveTopologyNodes(result, pinned);
  return resizeTopologyFrame(result, { modulePath: root.item.instancePath, x, y, width, height });
}

export function insertCanvasItem(project: Project, item: LibraryItem, moduleId: string, modulePath: InstancePath,
  instanceId: string, placement?: XYPosition | CenterPlacement, library?: LibraryConfig): Project {
  const position = typeof placement === 'function' ? undefined : placement;
  const updated = insertLibraryItem(project, item, moduleId, modulePath, instanceId, position, library);
  const key = hierarchyKey(modulePath);
  const frame = updated.layout?.topologyFrames?.find(frame => hierarchyKey(frame.modulePath) === key);
  if (!frame && typeof placement !== 'function') return updated;

  const owner = updated.moduleDefinitions.find(module => module.id === moduleId)!;
  const child = owner.instances.find(instance => instance.id === instanceId)!;
  const definition = updated.componentDefinitions.find(item => item.id === child.definitionId)
    ?? updated.moduleDefinitions.find(item => item.id === child.definitionId)!;
  if (typeof placement === 'function') {
    const centered = placement(definition, child.name);
    if (centered) return growFrameToFit(moveTopologyNode(updated, [...modulePath, instanceId], centered.position),
      { ...centered.position, ...estimatedBlockSize(definition.ports) }, centered.projection);
  }
  if (!frame) return updated;
  const anchor = position ?? defaultTopologyPosition(owner.instances.length - 1, owner.ports.length);
  const placed = placeDropGroup({ ...anchor, ...estimatedBlockSize(definition.ports) }, anchor, anchor, frame, frameInsets(owner.ports));
  const positioned = moveTopologyNode(updated, [...modulePath, instanceId], {
    x: anchor.x + placed.delta.x, y: anchor.y + placed.delta.y,
  });
  return placed.frame ? resizeTopologyFrame(positioned, placed.frame) : positioned;
}
