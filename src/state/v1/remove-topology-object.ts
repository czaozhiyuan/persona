import { resolveHierarchy } from '../../engine/v1/hierarchy';
import { mappingId } from '../../model/v1/types';
import type { InstancePath, Project, WireRef } from '../../model/v1/types';
import { outermostPaths } from './object-selection';
import { editModuleWiring } from './topology-edits';

export type { WireRef as WiringSelection } from '../../model/v1/types';

export function removeWiring(project: Project, moduleId: string, wire: WireRef): Project {
  return editModuleWiring(project, moduleId, module => {
    if (wire.kind === 'connection') return { ...module, connections: module.connections?.filter(item => item.id !== wire.id) };
    if (wire.kind === 'mapping') return { ...module, portMappings: module.portMappings?.filter(item => mappingId(item) !== wire.id) };
    return { ...module, cableBundles: module.cableBundles?.map(bundle =>
      bundle.id !== wire.bundleId ? bundle : { ...bundle, cores: bundle.cores.map(core =>
        core.id === wire.id ? { ...core, a: { pin: core.a.pin }, b: { pin: core.b.pin } } : core) }) };
  });
}

export function removeTopologyInstance(project: Project, parentId: string, instanceId: string): Project {
  return removeModuleChildren(project, parentId, new Set([instanceId]));
}

export function removeTopologyInstances(project: Project, paths: readonly InstancePath[]) {
  const original = resolveHierarchy(project);
  const byParent = new Map<string, InstancePath[]>();
  for (const path of outermostPaths(paths)) {
    if (!path.length || !original.resolveInstance(path)) throw new Error('所选对象已不存在或是编辑边界。');
    const parentId = original.resolveInstance(path.slice(0, -1))!.definition.id;
    const siblings = byParent.get(parentId);
    if (siblings) siblings.push(path);
    else byParent.set(parentId, [path]);
  }

  // Maximum occurrence depth orders every parent definition before its descendants, even across reused modules.
  const depth = new Map<string, number>();
  for (const { definition, instancePath } of original.walkInstances()) {
    if (byParent.has(definition.id)) depth.set(definition.id, Math.max(depth.get(definition.id) ?? 0, instancePath.length));
  }
  const parents = [...byParent.keys()].sort((a, b) => depth.get(a)! - depth.get(b)!);
  const affected = new Set<string>();
  for (const parentId of parents) {
    const live = affected.size ? resolveHierarchy(project) : original;
    const slots = new Set(byParent.get(parentId)!.filter(path => live.resolveInstance(path)).map(path => path.at(-1)!));
    if (!slots.size) continue;
    project = removeModuleChildren(project, parentId, slots, live);
    affected.add(parentId);
  }
  return { project, affected };
}

function removeModuleChildren(project: Project, parentId: string, slots: ReadonlySet<string>, hierarchy = resolveHierarchy(project)): Project {
  const parentPaths = new Set<string>();
  for (const occurrence of hierarchy.walkInstances()) {
    if (occurrence.definition.id === parentId) parentPaths.add(JSON.stringify(occurrence.instancePath));
  }
  const removed = (path: InstancePath) => path.some((id, index) => slots.has(id) && parentPaths.has(JSON.stringify(path.slice(0, index))));
  const updated = editModuleWiring(project, parentId, module => ({
    ...module,
    instances: module.instances.filter(item => !slots.has(item.id)),
    connections: module.connections?.filter(item => !slots.has(item.from.instanceId) && !slots.has(item.to.instanceId)),
    portMappings: module.portMappings?.filter(item => !slots.has(item.target.instanceId)),
    parameterMappings: module.parameterMappings?.filter(item => !slots.has(item.target.instanceId)),
    cableBundles: module.cableBundles?.map(bundle => ({ ...bundle, cores: bundle.cores.map(core => ({
      ...core,
      a: core.a.endpoint && slots.has(core.a.endpoint.instanceId) ? { pin: core.a.pin } : core.a,
      b: core.b.endpoint && slots.has(core.b.endpoint.instanceId) ? { pin: core.b.pin } : core.b,
    })) })),
  }));
  const { layout } = updated;
  return {
    ...updated,
    instanceSettings: updated.instanceSettings?.filter(item => !removed(item.instancePath)),
    layout: layout && {
      ...layout,
      physical: layout.physical?.filter(item => !removed(item.instancePath) && !removed(item.enclosurePath)),
      topology: layout.topology?.filter(item => !removed(item.instancePath)),
      topologyFrames: layout.topologyFrames?.filter(item => !removed(item.modulePath)),
    },
    namedLinks: updated.namedLinks?.map(link => ({
      ...link,
      from: link.from && !removed(link.from.instancePath) ? link.from : undefined,
      to: link.to && !removed(link.to.instancePath) ? link.to : undefined,
      // editModuleWiring already clears removed wire references in every parent occurrence.
      via: link.via?.filter(item => !removed(item.scopePath)),
      ...(link.trial && { trial: { ...link.trial, opticalSources: link.trial.opticalSources?.filter(source => !removed(source.endpoint.instancePath)) } }),
    })),
  };
}
