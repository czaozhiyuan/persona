import { portDisplayName } from '../../model/v1/display-names';
import { resolveHierarchy } from '../../engine/v1/hierarchy';
import type { CableCoreRef, CableCore, LocalEndpointRef } from '../../model/v1/topology';
import type { ConnectionRef, EndpointRef, InstancePath, ModuleDefinition, Project, TopologyFrame } from '../../model/v1/types';

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

type TopologyMove = { instancePath: InstancePath; x: number; y: number };

export function moveTopologyNodes(project: Project, moves: readonly TopologyMove[]): Project {
  if (!moves.length) return project;
  const paths = new Set(moves.map(move => JSON.stringify(move.instancePath)));
  const topology = (project.layout?.topology ?? []).filter(placement => !paths.has(JSON.stringify(placement.instancePath)));
  return { ...project, layout: { ...project.layout, topology: [...topology, ...moves] } };
}

export function moveTopologyNode(project: Project, instancePath: InstancePath, position: { x: number; y: number }): Project {
  return moveTopologyNodes(project, [{ instancePath, x: position.x, y: position.y }]);
}

export function resizeTopologyFrame(project: Project, frame: TopologyFrame): Project {
  const key = JSON.stringify(frame.modulePath);
  const topologyFrames = (project.layout?.topologyFrames ?? []).filter(item => JSON.stringify(item.modulePath) !== key);
  return { ...project, layout: { ...project.layout, topologyFrames: [...topologyFrames, frame] } };
}

type ImpactKind = '端口' | '连接' | '端口映射' | '纤芯附件' | '器件传输' | '开关路由' | '链路端点' | '链路必经边' | '直流电源' | '直流负载';
export type PortDeletionImpact = {
  kind: ImpactKind;
  name: string;
  definitionId: string;
  paths: readonly InstancePath[];
};

export function planPortDeletion(project: Project, definitionId: string, portId: string) {
  const hierarchy = resolveHierarchy(project);
  const instances = new Map<string, string>();
  const pathsByDefinition = new Map<string, InstancePath[]>();
  for (const occurrence of hierarchy.walkInstances()) {
    const { definition, instancePath } = occurrence;
    instances.set(JSON.stringify(instancePath), definition.id);
    const paths = pathsByDefinition.get(definition.id) ?? [];
    if (!pathsByDefinition.has(definition.id)) pathsByDefinition.set(definition.id, paths);
    paths.push(instancePath);
  }
  const definitions = new Map([...project.moduleDefinitions, ...project.componentDefinitions].map(definition => [definition.id, definition]));
  const removedPort = definitions.get(definitionId)?.ports.find(port => port.id === portId);
  if (!removedPort) return undefined;

  const impacts: PortDeletionImpact[] = [];
  function report(kind: ImpactKind, name: string, scope: string, path?: InstancePath) {
    impacts.push({ kind, name, definitionId: scope, paths: path === undefined ? pathsByDefinition.get(scope) ?? [] : [path] });
  }
  const removedLabel = (path?: InstancePath) => portDisplayName(removedPort, false, definitions.get(definitionId)?.ports,
    path && hierarchy.resolveInstance(path)?.parameters);
  reportEndpoints('端口', definitionId, removedLabel);

  function reportEndpoints(kind: ImpactKind, scope: string, describe: (path?: InstancePath) => string) {
    const paths = pathsByDefinition.get(scope) ?? [];
    if (!paths.length) return report(kind, describe(), scope);
    const groups = new Map<string, InstancePath[]>();
    for (const path of paths) {
      const label = describe(path);
      const group = groups.get(label);
      if (group) group.push(path);
      else groups.set(label, [path]);
    }
    for (const [name, locations] of groups) impacts.push({ kind, name, definitionId: scope, paths: locations });
  }

  function endpointLabel(module: ModuleDefinition, ref: LocalEndpointRef, path?: InstancePath) {
    const instance = module.instances.find(instance => instance.id === ref.instanceId)!;
    const child = path && hierarchy.resolveInstance([...path, instance.id]);
    const ports = definitions.get(instance.definitionId)?.ports;
    const port = ports?.find(port => port.id === ref.portId);
    return `${child?.instance?.name || instance.name} · ${port ? portDisplayName(port, false, ports, child?.parameters) : '未找到的端口'}`;
  }

  const componentDefinitions = project.componentDefinitions.map(component => {
    if (component.id !== definitionId) return component;
    const portName = (id: string, path?: InstancePath) => portDisplayName(component.ports.find(p => p.id === id)!, false, component.ports,
      path && hierarchy.resolveInstance(path)?.parameters);
    const clearSupply = component.dcSupply?.portId === portId;
    const clearLoad = component.dcLoad?.portId === portId;
    if (clearSupply) reportEndpoints('直流电源', component.id, removedLabel);
    if (clearLoad) reportEndpoints('直流负载', component.id, removedLabel);
    return {
      ...component,
      ports: component.ports.filter(port => port.id !== portId),
      ...(clearSupply && { dcSupply: undefined }),
      ...(clearLoad && { dcLoad: undefined }),
      transfers: component.transfers?.filter(transfer => {
        const removed = transfer.fromPortId === portId || transfer.toPortId === portId
          || (transfer.kind === 'eo' && transfer.supplyPortId === portId) || (transfer.kind === 'splitter' && transfer.secondPortId === portId);
        if (removed) reportEndpoints('器件传输', component.id, path => `${portName(transfer.fromPortId, path)} → ${portName(transfer.toPortId, path)}`);
        return !removed;
      }),
      switchStates: component.switchStates?.map(state => ({
        ...state, routes: state.routes.filter(route => {
          const removed = route.fromPortId === portId || route.toPortId === portId;
          if (removed) report('开关路由', `${state.name} · ${portName(route.fromPortId)} → ${portName(route.toPortId)}`, component.id);
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
        if (removed) reportEndpoints('连接', module.id, path =>
          `${endpointLabel(module, connection.from, path)} → ${endpointLabel(module, connection.to, path)}`);
        return !removed;
      }),
      portMappings: module.portMappings?.filter(mapping => {
        const removed = (module.id === definitionId && mapping.portId === portId) || hits(mapping.target);
        if (removed) {
          const port = module.ports.find(port => port.id === mapping.portId)!;
          reportEndpoints('端口映射', module.id, path =>
            `${portDisplayName(port, false, module.ports, path && hierarchy.resolveInstance(path)?.parameters)} ↔ ${endpointLabel(module, mapping.target, path)}`);
        }
        return !removed;
      }),
      cableBundles: module.cableBundles?.map((bundle, index) => ({
        ...bundle, cores: bundle.cores.map(core => ({
          ...core,
          a: clearAttachment(core.a, `线缆 ${index + 1} · A:${core.a.pin}`),
          b: clearAttachment(core.b, `线缆 ${index + 1} · B:${core.b.pin}`),
        })),
      })),
    };
  });

  const modules = new Map(moduleDefinitions.map(module => [module.id, module]));
  const scopeId = (path: InstancePath) => instances.get(JSON.stringify(path))!;
  const namedLinks = project.namedLinks?.map(link => {
    const clearEndpoint = (label: string, endpoint?: EndpointRef) => {
      if (!endpoint || endpoint.portId !== portId || scopeId(endpoint.instancePath) !== definitionId) return endpoint;
      report('链路端点', `${link.name} / ${label}`, definitionId, endpoint.instancePath);
      return undefined;
    };
    return {
      ...link,
      from: clearEndpoint('起点', link.from), to: clearEndpoint('终点', link.to),
      via: link.via?.filter(ref => {
        const scope = scopeId(ref.scopePath);
        if (hasVia(modules.get(scope)!, ref)) return true;
        const original = definitions.get(scope);
        const wire = original?.kind === 'module' && 'connectionId' in ref && original.connections?.find(w => w.id === ref.connectionId);
        const edge = wire && original?.kind === 'module'
          ? `${endpointLabel(original, wire.from, ref.scopePath)} → ${endpointLabel(original, wire.to, ref.scopePath)}` : '受影响的纤芯';
        report('链路必经边', `${link.name} / ${edge}`, scope, ref.scopePath);
        return false;
      }),
      ...(link.trial && { trial: { ...link.trial, opticalSources: link.trial.opticalSources?.filter(({ endpoint }) => {
        const removed = endpoint.portId === portId && scopeId(endpoint.instancePath) === definitionId;
        if (removed) report('链路端点', `${link.name} / 试算光源`, definitionId, endpoint.instancePath);
        return !removed;
      }) } }),
    };
  });
  return { impacts, project: { ...project, componentDefinitions, moduleDefinitions, namedLinks } };
}
