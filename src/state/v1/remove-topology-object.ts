import { resolveHierarchy } from '../../engine/v1/hierarchy';
import type { InstancePath, Project } from '../../model/v1/types';
import { editModuleWiring } from './topology-edits';

export type WiringSelection =
  | { kind: 'connection'; id: string }
  | { kind: 'mapping'; id: string }
  | { kind: 'core'; id: string; bundleId: string };

export function removeWiring(project: Project, moduleId: string, wire: WiringSelection): Project {
  return editModuleWiring(project, moduleId, module => {
    if (wire.kind === 'connection') return { ...module, connections: module.connections?.filter(item => item.id !== wire.id) };
    if (wire.kind === 'mapping') return { ...module, portMappings: module.portMappings?.filter(item => item.portId !== wire.id) };
    return { ...module, cableBundles: module.cableBundles?.map(bundle =>
      bundle.id !== wire.bundleId ? bundle : { ...bundle, cores: bundle.cores.map(core =>
        core.id === wire.id ? { ...core, a: { pin: core.a.pin }, b: { pin: core.b.pin } } : core) }) };
  });
}

export function removeTopologyInstance(project: Project, parentId: string, instanceId: string): Project {
  const removedRoots: InstancePath[] = [];
  for (const occurrence of resolveHierarchy(project).walkInstances()) {
    if (occurrence.definition.id === parentId) removedRoots.push([...occurrence.instancePath, instanceId]);
  }
  const removed = (path: InstancePath) => removedRoots.some(root =>
    root.length <= path.length && root.every((part, index) => path[index] === part));
  const updated = editModuleWiring(project, parentId, module => ({
    ...module,
    instances: module.instances.filter(item => item.id !== instanceId),
    connections: module.connections?.filter(item => item.from.instanceId !== instanceId && item.to.instanceId !== instanceId),
    portMappings: module.portMappings?.filter(item => item.target.instanceId !== instanceId),
    parameterMappings: module.parameterMappings?.filter(item => item.target.instanceId !== instanceId),
    cableBundles: module.cableBundles?.map(bundle => ({ ...bundle, cores: bundle.cores.map(core => ({
      ...core,
      a: core.a.endpoint?.instanceId === instanceId ? { pin: core.a.pin } : core.a,
      b: core.b.endpoint?.instanceId === instanceId ? { pin: core.b.pin } : core.b,
    })) })),
  }));
  const { layout } = updated;
  return {
    ...updated,
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
      via: link.via?.filter(item => !removed(item.scopePath)),
      conversionBindings: link.conversionBindings?.filter(item =>
        !removed(item.eo.instancePath) && !removed(item.oe.instancePath)),
    })),
  };
}
