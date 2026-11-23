import type { LibraryConfig } from '../../../library/v1/user-library';
import type { XYPosition } from '@xyflow/react';
import { resolveHierarchy } from '../../../engine/v1/hierarchy';
import { insertLibraryItem } from '../../../library/v1/insert-library-item';
import type { LibraryItem } from '../../../library/v1/insert-library-item';
import type { InstancePath, Project, TopologyPlacement } from '../../../model/v1/types';
import { moveTopologyNode, moveTopologyNodes, resizeTopologyFrame } from '../../../state/v1/topology-edits';
import { defaultTopologyPosition } from '../../../state/v1/topology-position';
import { hierarchyKey } from './hierarchy-view';
import { frameInsets } from './module-frame';
import { placeDropGroup } from './reparent-drop';
import { estimatedBlockSize, projectTopology } from './topology-projection';

type Projection = ReturnType<typeof projectTopology>;

export function preserveDeletionLayout(project: Project, parentId: string, before: Projection,
  scope: InstancePath, expanded: ReadonlySet<string>, measured: Parameters<typeof projectTopology>[4]): Project {
  const affected = new Set<string>();
  for (const { definition, path } of before.scopes.values()) {
    if (definition.id !== parentId) continue;
    for (let depth = scope.length; depth <= path.length; depth++) {
      affected.add(hierarchyKey(path.slice(0, depth)));
    }
  }
  if (!affected.size) return project;

  const instances = [...resolveHierarchy(project).walkInstances()];
  const after = projectTopology(project, instances, scope, expanded, measured);
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
  const final = preserved === project ? after : projectTopology(preserved, instances, scope, expanded, measured);
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

export function insertCanvasItem(project: Project, item: LibraryItem, moduleId: string, modulePath: InstancePath,
  instanceId: string, position?: XYPosition, library?: LibraryConfig): Project {
  const updated = insertLibraryItem(project, item, moduleId, modulePath, instanceId, position, library);
  const key = hierarchyKey(modulePath);
  const frame = updated.layout?.topologyFrames?.find(frame => hierarchyKey(frame.modulePath) === key);
  if (!frame) return updated;

  const owner = updated.moduleDefinitions.find(module => module.id === moduleId)!;
  const child = owner.instances.find(instance => instance.id === instanceId)!;
  const definition = updated.componentDefinitions.find(item => item.id === child.definitionId)
    ?? updated.moduleDefinitions.find(item => item.id === child.definitionId)!;
  const anchor = position ?? defaultTopologyPosition(owner.instances.length - 1, owner.ports.length);
  const placed = placeDropGroup({ ...anchor, ...estimatedBlockSize(definition.ports) }, anchor, anchor, frame, frameInsets(owner.ports));
  const positioned = moveTopologyNode(updated, [...modulePath, instanceId], {
    x: anchor.x + placed.delta.x, y: anchor.y + placed.delta.y,
  });
  return placed.frame ? resizeTopologyFrame(positioned, placed.frame) : positioned;
}
