import { resolveHierarchy } from '../../engine/v1/hierarchy';
import type { InstancePath, PortDefinition, Project } from '../../model/v1/types';
import type { LocalEndpointRef } from '../../model/v1/topology';
import { editModule } from './topology-edits';

export function exposeModulePort(project: Project, scope: InstancePath, target: LocalEndpointRef, name: string): Project {
  const hierarchy = resolveHierarchy(project);
  const module = hierarchy.resolveInstance(scope)?.definition;
  const child = hierarchy.resolveInstance([...scope, target.instanceId]);
  const inner = child?.definition.ports.find(port => port.id === target.portId);
  if (module?.kind !== 'module' || !inner) throw new Error('请选择当前模块的直接子实例端口。');
  const used = new Set(module.ports.map(port => port.id));
  let id = inner.id;
  for (let suffix = 2; used.has(id); suffix++) id = `${inner.id}_${suffix}`;
  const port: PortDefinition = { id, name: name.trim(), type: inner.type, direction: inner.direction,
    ...(inner.channelIds && { channelIds: inner.channelIds }) };
  return editModule(project, module.id, current => ({
    ...current,
    ports: [...current.ports, port],
    portMappings: [...(current.portMappings ?? []), { portId: id, target }],
  }));
}

export function renamePort(project: Project, definitionId: string, portId: string, name: string): Project {
  const update = (port: PortDefinition) => port.id === portId ? { ...port, name: name.trim() || undefined } : port;
  return {
    ...project,
    moduleDefinitions: project.moduleDefinitions.map(item => item.id === definitionId ? { ...item, ports: item.ports.map(update) } : item),
    componentDefinitions: project.componentDefinitions.map(item => item.id === definitionId ? { ...item, ports: item.ports.map(update) } : item),
  };
}

export function connectBoundaryPort(project: Project, definitionId: string, portId: string, target?: LocalEndpointRef): Project {
  return editModule(project, definitionId, module => ({
    ...module,
    portMappings: [...(module.portMappings ?? []).filter(item => item.portId !== portId), ...(target ? [{ portId, target }] : [])],
  }));
}
