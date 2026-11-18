import { resolveHierarchy } from '../../engine/v1/hierarchy';
import type { CableCoreRef, CableCore, ConversionBoundary, LocalEndpointRef } from '../../model/v1/topology';
import type { ConnectionRef, EndpointRef, InstancePath, ModuleDefinition, Project } from '../../model/v1/types';

type Via = ConnectionRef | CableCoreRef;

function hasVia(module: ModuleDefinition, ref: Via): boolean {
  return 'bundleId' in ref
    ? Boolean(module.cableBundles?.find(bundle => bundle.id === ref.bundleId)?.cores.some(core => core.id === ref.coreId))
    : Boolean(module.connections?.some(connection => connection.id === ref.connectionId));
}

export function editModule(project: Project, moduleId: string, change: (module: ModuleDefinition) => ModuleDefinition): Project {
  return { ...project, moduleDefinitions: project.moduleDefinitions.map(module => module.id === moduleId ? change(module) : module) };
}

/** Remove only required edges whose records were deleted from the edited module. */
export function editModuleWiring(project: Project, moduleId: string, change: (module: ModuleDefinition) => ModuleDefinition): Project {
  const before = project.moduleDefinitions.find(item => item.id === moduleId)!;
  const updated = editModule(project, moduleId, change);
  const module = updated.moduleDefinitions.find(item => item.id === moduleId)!;
  const removed = (ref: Via) => hasVia(before, ref) && !hasVia(module, ref);
  if (!project.namedLinks?.some(link => link.via?.some(removed))) return updated;
  const hierarchy = resolveHierarchy(project);
  const namedLinks = project.namedLinks.map(link => {
    const via = link.via?.filter(ref => !removed(ref) || hierarchy.resolveInstance(ref.scopePath)?.definition.id !== moduleId);
    return via?.length === link.via?.length ? link : { ...link, via };
  });
  return { ...updated, namedLinks };
}

export function moveTopologyNode(project: Project, instancePath: InstancePath, position: { x: number; y: number }): Project {
  const topology = (project.layout?.topology ?? []).filter(placement =>
    placement.instancePath.length !== instancePath.length || placement.instancePath.some((id, i) => id !== instancePath[i]));
  return { ...project, layout: { ...project.layout, topology: [...topology, { instancePath, x: position.x, y: position.y }] } };
}

type ImpactKind = '端口' | '连接' | '端口映射' | '纤芯附件' | '器件传输' | '开关路由' | '链路端点' | '链路必经边' | '标定绑定';
export type PortDeletionImpact = {
  kind: ImpactKind;
  name: string;
  definitionId: string;
  paths: readonly InstancePath[];
};

export function planPortDeletion(project: Project, definitionId: string, portId: string) {
  const instances = new Map<string, string>();
  const pathsByDefinition = new Map<string, InstancePath[]>();
  for (const occurrence of resolveHierarchy(project).walkInstances()) {
    const { definition, instancePath } = occurrence;
    instances.set(JSON.stringify(instancePath), definition.id);
    const paths = pathsByDefinition.get(definition.id) ?? [];
    if (!pathsByDefinition.has(definition.id)) pathsByDefinition.set(definition.id, paths);
    paths.push(instancePath);
  }
  const selected = [...project.moduleDefinitions, ...project.componentDefinitions].find(definition => definition.id === definitionId);
  if (!selected?.ports.some(port => port.id === portId)) return undefined;

  const impacts: PortDeletionImpact[] = [];
  function report(kind: ImpactKind, name: string, scope: string, path?: InstancePath) {
    impacts.push({ kind, name, definitionId: scope, paths: path === undefined ? pathsByDefinition.get(scope) ?? [] : [path] });
  }
  report('端口', portId, definitionId);

  const componentDefinitions = project.componentDefinitions.map(component => {
    if (component.id !== definitionId) return component;
    return {
      ...component,
      ports: component.ports.filter(port => port.id !== portId),
      transfers: component.transfers?.filter(transfer => {
        const removed = transfer.fromPortId === portId || transfer.toPortId === portId
          || (transfer.kind === 'eo' && transfer.supplyPortId === portId);
        if (removed) report('器件传输', `${transfer.kind}: ${transfer.fromPortId} → ${transfer.toPortId}`, component.id);
        return !removed;
      }),
      switchStates: component.switchStates?.map(state => ({
        ...state, routes: state.routes.filter(route => {
          const removed = route.fromPortId === portId || route.toPortId === portId;
          if (removed) report('开关路由', `${state.id}: ${route.fromPortId} → ${route.toPortId}`, component.id);
          return !removed;
        }),
      })),
    };
  });
  const moduleDefinitions = project.moduleDefinitions.map(module => {
    const affectedInstances = new Set(module.instances.filter(item => item.definitionId === definitionId).map(item => item.id));
    const hits = (end?: LocalEndpointRef) => end?.portId === portId && affectedInstances.has(end.instanceId);
    const clearAttachment = (side: CableCore['a'], name: string) => {
      if (!hits(side.endpoint)) return side;
      report('纤芯附件', name, module.id);
      return { pin: side.pin };
    };
    return {
      ...module,
      ports: module.id === definitionId ? module.ports.filter(port => port.id !== portId) : module.ports,
      connections: module.connections?.filter(connection => {
        const removed = hits(connection.from) || hits(connection.to);
        if (removed) report('连接', connection.id, module.id);
        return !removed;
      }),
      portMappings: module.portMappings?.filter(mapping => {
        const removed = (module.id === definitionId && mapping.portId === portId) || hits(mapping.target);
        if (removed) report('端口映射', mapping.portId, module.id);
        return !removed;
      }),
      cableBundles: module.cableBundles?.map(bundle => ({
        ...bundle, cores: bundle.cores.map(core => ({
          ...core,
          a: clearAttachment(core.a, `${bundle.id} / ${core.id} A:${core.a.pin}`),
          b: clearAttachment(core.b, `${bundle.id} / ${core.id} B:${core.b.pin}`),
        })),
      })),
    };
  });

  const modules = new Map(moduleDefinitions.map(module => [module.id, module]));
  const components = new Map(componentDefinitions.map(component => [component.id, component]));
  const scopeId = (path: InstancePath) => instances.get(JSON.stringify(path))!;
  function boundaryExists(kind: 'eo' | 'oe', boundary: ConversionBoundary) {
    return components.get(scopeId(boundary.instancePath))?.transfers?.some(transfer =>
      transfer.kind === kind && transfer.fromPortId === boundary.fromPortId && transfer.toPortId === boundary.toPortId);
  }
  const namedLinks = project.namedLinks?.map(link => {
    const clearEndpoint = (label: string, endpoint?: EndpointRef) => {
      if (!endpoint || endpoint.portId !== portId || scopeId(endpoint.instancePath) !== definitionId) return endpoint;
      report('链路端点', `${link.id} / ${label}`, definitionId, endpoint.instancePath);
      return undefined;
    };
    return {
      ...link,
      from: clearEndpoint('起点', link.from), to: clearEndpoint('终点', link.to),
      via: link.via?.filter(ref => {
        const scope = scopeId(ref.scopePath);
        if (hasVia(modules.get(scope)!, ref)) return true;
        const id = 'bundleId' in ref ? `${ref.bundleId} / ${ref.coreId}` : ref.connectionId;
        report('链路必经边', `${link.id} / ${id}`, scope, ref.scopePath);
        return false;
      }),
      conversionBindings: link.conversionBindings?.filter(binding => {
        const invalid = (['eo', 'oe'] as const).filter(kind => !boundaryExists(kind, binding[kind]));
        for (const kind of invalid) {
          const { instancePath } = binding[kind];
          report('标定绑定', `${link.id} / ${binding.id} (${kind.toUpperCase()})`, scopeId(instancePath), instancePath);
        }
        return invalid.length === 0;
      }),
    };
  });
  return { impacts, project: { ...project, componentDefinitions, moduleDefinitions, namedLinks } };
}
