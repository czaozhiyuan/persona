import { resolveHierarchy } from '../../engine/v1/hierarchy';
import { isPowerPort } from '../../model/v1/types';
import type { InstancePath, PortDefinition, Project } from '../../model/v1/types';
import type { LocalEndpointRef } from '../../model/v1/topology';
import { editModule } from './topology-edits';

export function boundaryPort(inner: PortDefinition, id: string, name: string): PortDefinition {
  const port: PortDefinition = { id, type: inner.type, direction: inner.direction };
  if (!isPowerPort(inner.type)) port.name = name.trim();
  if (inner.channelIds) port.channelIds = inner.channelIds;
  return port;
}

export function exposeModulePort(project: Project, scope: InstancePath, target: LocalEndpointRef, name: string): Project {
  const hierarchy = resolveHierarchy(project);
  const module = hierarchy.resolveInstance(scope)?.definition;
  const child = hierarchy.resolveInstance([...scope, target.instanceId]);
  const inner = child?.definition.ports.find(port => port.id === target.portId);
  if (module?.kind !== 'module' || !inner) throw new Error('请选择当前模块的直接子实例端口。');
  const used = new Set(module.ports.map(port => port.id));
  let id = inner.id;
  for (let suffix = 2; used.has(id); suffix++) id = `${inner.id}_${suffix}`;
  const port = boundaryPort(inner, id, name);
  return editModule(project, module.id, current => ({
    ...current,
    ports: [...current.ports, port],
    portMappings: [...(current.portMappings ?? []), { portId: id, target }],
  }));
}

function editDefinitionPorts(project: Project, definitionId: string,
  change: (ports: readonly PortDefinition[]) => readonly PortDefinition[]): Project {
  const module = project.moduleDefinitions.find(item => item.id === definitionId);
  if (module) return editModule(project, definitionId, current => ({ ...current, ports: change(current.ports) }));
  if (!project.componentDefinitions.some(item => item.id === definitionId)) throw new Error('目标定义已不存在。');
  return { ...project, componentDefinitions: project.componentDefinitions.map(item =>
    item.id === definitionId ? { ...item, ports: change(item.ports) } : item) };
}

export function addDefinitionPort(project: Project, definitionId: string, port: PortDefinition): Project {
  const name = isPowerPort(port.type) ? undefined : port.name?.trim();
  if (!isPowerPort(port.type) && !name) throw new Error('请输入端口名称。');
  return editDefinitionPorts(project, definitionId, ports => {
    if (ports.some(item => item.id === port.id)) throw new Error('端口 ID 重复，请重试。');
    return [...ports, { ...port, name }];
  });
}

export function renamePort(project: Project, definitionId: string, portId: string, name: string): Project {
  return editDefinitionPorts(project, definitionId, ports =>
    ports.map(port => port.id === portId && !isPowerPort(port.type) ? { ...port, name: name.trim() || undefined } : port));
}

export function connectBoundaryPort(project: Project, definitionId: string, portId: string, target?: LocalEndpointRef): Project {
  return editModule(project, definitionId, module => ({
    ...module,
    portMappings: [...(module.portMappings ?? []).filter(item => item.portId !== portId), ...(target ? [{ portId, target }] : [])],
  }));
}
