import { retainWireRoutes } from './wire-routes';
import { portDisplayName } from '../../model/v1/display-names';
import { boundaryPort } from './module-ports';
import { moduleName } from './module-name';
import { resolveHierarchy } from '../../engine/v1/hierarchy';
import type { ParameterDefinition, ParameterMapping } from '../../model/v1/parameters';
import type { CableBundle, Connection, LocalEndpointRef } from '../../model/v1/topology';
import type { EndpointRef, InstancePath, ModuleDefinition, PortDefinition, PortMapping, Project, TopologyPlacement } from '../../model/v1/types';
import { gridPoint } from './topology-grid';
import { defaultTopologyPosition } from './topology-position';

const pathKey = (path: InstancePath) => JSON.stringify(path);

export function groupModule(project: Project, paths: readonly InstancePath[], name: string, instanceId: string, definitionId: string): Project {
  const scope = paths[0]?.slice(0, -1);
  if (!scope || paths.length < 2 || paths.some(path => !path.length || pathKey(path.slice(0, -1)) !== pathKey(scope))) {
    throw new Error('请选择同一直接父模块下的至少两个对象。');
  }
  const hierarchy = resolveHierarchy(project);
  const parent = hierarchy.resolveInstance(scope)?.definition;
  const selected = new Set(paths.map(path => path.at(-1)!));
  if (parent?.kind !== 'module' || selected.size !== paths.length || [...selected].some(id => !parent.instances.some(item => item.id === id))) {
    throw new Error('选中的实例已变化，请重新选择。');
  }
  const children = parent.instances.filter(item => selected.has(item.id));
  const definitions = new Map([...project.moduleDefinitions, ...project.componentDefinitions].map(item => [item.id, item]));
  const childById = new Map(children.map(child => [child.id, child]));
  const internalConnections: Connection[] = [];
  const parentConnections: Connection[] = [];
  const internalBundles: CableBundle[] = [];
  const parentBundles: CableBundle[] = [];
  const ports: PortDefinition[] = [];
  const portMappings: PortMapping[] = [];
  const exposed = new Map<string, string>();
  const portIds = new Set<string>();
  const groupName = moduleName(project, name);

  const throughBoundary = (ref: LocalEndpointRef): LocalEndpointRef => {
    const child = childById.get(ref.instanceId);
    if (!child) return ref;
    const key = JSON.stringify([ref.instanceId, ref.portId]);
    let id = exposed.get(key);
    if (id === undefined) {
      const port = definitions.get(child.definitionId)!.ports.find(item => item.id === ref.portId)!;
      id = port.id;
      for (let suffix = 2; portIds.has(id); suffix++) id = `${port.id}_${suffix}`;
      portIds.add(id);
      exposed.set(key, id);
      const name = `${hierarchy.resolveInstance([...scope, child.id])?.instance?.name ?? child.name} · ${portDisplayName(port)}`;
      ports.push(boundaryPort(port, id, name));
      portMappings.push({ portId: id, target: ref });
    }
    return { instanceId, portId: id };
  };

  for (const wire of parent.connections ?? []) {
    if (selected.has(wire.from.instanceId) && selected.has(wire.to.instanceId)) internalConnections.push(wire);
    else parentConnections.push({ ...wire, from: throughBoundary(wire.from), to: throughBoundary(wire.to) });
  }
  for (const bundle of parent.cableBundles ?? []) {
    const attached = bundle.cores.flatMap(core => [core.a.endpoint, core.b.endpoint]).filter(ref => ref !== undefined);
    if (attached.length && attached.every(ref => selected.has(ref.instanceId))) {
      internalBundles.push(bundle);
    } else {
      if (bundle.cores.some(core => core.a.endpoint && core.b.endpoint
        && selected.has(core.a.endpoint.instanceId) && selected.has(core.b.endpoint.instanceId))) {
        throw new Error(`线束 ${(parent.cableBundles ?? []).indexOf(bundle) + 1} 同时包含组内纤芯和组外附件，无法整体移动。请选择线束的全部已接对象，或调整选区。`);
      }
      parentBundles.push({ ...bundle, cores: bundle.cores.map(core => ({
        ...core,
        a: core.a.endpoint ? { ...core.a, endpoint: throughBoundary(core.a.endpoint) } : core.a,
        b: core.b.endpoint ? { ...core.b, endpoint: throughBoundary(core.b.endpoint) } : core.b,
      })) });
    }
  }
  const parentMappings = parent.portMappings?.map(mapping => ({ ...mapping, target: throughBoundary(mapping.target) }));
  const parameters = new Map<string, ParameterDefinition>();
  const internalParameterMappings: ParameterMapping[] = [];
  const parentParameterMappings: ParameterMapping[] = [];
  for (const mapping of parent.parameterMappings ?? []) {
    if (!selected.has(mapping.target.instanceId)) {
      parentParameterMappings.push(mapping);
    } else {
      const source = parent.parameters!.find(parameter => parameter.id === mapping.parameterId)!;
      if (!parameters.has(source.id)) {
        const { defaultValue: _default, ...forwarded } = source;
        parameters.set(source.id, { ...forwarded, overridable: true });
        parentParameterMappings.push({ parameterId: source.id, target: { instanceId, parameterId: source.id } });
      }
      internalParameterMappings.push(mapping);
    }
  }

  const occurrences = [...hierarchy.walkInstances()].filter(item => item.definition.id === parent.id);
  const parentPaths = new Set(occurrences.map(item => pathKey(item.instancePath)));
  function remap(path: InstancePath): InstancePath {
    for (let index = 0; index < path.length; index++) {
      if (selected.has(path[index]) && parentPaths.has(pathKey(path.slice(0, index)))) {
        return [...path.slice(0, index), instanceId, ...path.slice(index)];
      }
    }
    return path;
  }
  function endpoint<T extends { instancePath: InstancePath }>(ref: T): T {
    return { ...ref, instancePath: remap(ref.instancePath) };
  }
  function optional(ref?: EndpointRef) { return ref && endpoint(ref); }

  const movedWires = new Set(internalConnections.map(wire => wire.id));
  const movedBundles = new Set(internalBundles.map(bundle => bundle.id));
  const namedLinks = project.namedLinks?.map(link => ({
    ...link, from: optional(link.from), to: optional(link.to),
    via: link.via?.map(ref => ({
      ...ref, scopePath: parentPaths.has(pathKey(ref.scopePath)) &&
        ('bundleId' in ref ? movedBundles.has(ref.bundleId) : movedWires.has(ref.connectionId))
        ? [...ref.scopePath, instanceId] : remap(ref.scopePath),
    })),
    ...(link.trial && { trial: { ...link.trial, opticalSources: link.trial.opticalSources?.map(source => ({
      ...source, endpoint: endpoint(source.endpoint),
    })) } }),
  }));
  const layout = project.layout;
  const positions = new Map(layout?.topology?.map(placement => [pathKey(placement.instancePath), placement]));
  const topology = (layout?.topology ?? []).filter(item => !parentPaths.has(pathKey(item.instancePath.slice(0, -1)))).map(endpoint);
  for (const { instancePath } of occurrences) {
    const direct = parent.instances.map((child, index): TopologyPlacement => {
      const path = [...instancePath, child.id];
      return positions.get(pathKey(path)) ?? { instancePath: path, ...defaultTopologyPosition(index, parent.ports.length) };
    });
    const moving = direct.filter(item => selected.has(item.instancePath.at(-1)!));
    const x = Math.min(...moving.map(item => item.x));
    const y = Math.min(...moving.map(item => item.y));
    topology.push({ instancePath: [...instancePath, instanceId], ...gridPoint({ x, y }) });
    for (const item of direct) {
      topology.push(selected.has(item.instancePath.at(-1)!) ? {
        instancePath: remap(item.instancePath), x: item.x - x, y: item.y - y,
      } : item);
    }
  }

  const first = parent.instances.findIndex(item => selected.has(item.id));
  const instances = parent.instances.filter(item => !selected.has(item.id));
  instances.splice(first, 0, { id: instanceId, definitionId, name: groupName });
  const enclosing: ModuleDefinition = { ...parent, instances,
    connections: parent.connections && parentConnections, cableBundles: parent.cableBundles && parentBundles,
    portMappings: parentMappings, parameterMappings: parent.parameterMappings && parentParameterMappings,
  };
  const group: ModuleDefinition = {
    id: definitionId, name: groupName, kind: 'module', instances: children, ports,
    ...(internalConnections.length > 0 && { connections: internalConnections }),
    ...(internalBundles.length > 0 && { cableBundles: internalBundles }),
    ...(portMappings.length > 0 && { portMappings }),
    ...(parameters.size > 0 && { parameters: [...parameters.values()], parameterMappings: internalParameterMappings }),
  };
  return retainWireRoutes(project, {
    ...project,
    moduleDefinitions: [...project.moduleDefinitions.map(item => item.id === parent.id ? enclosing : item), group],
    instanceSettings: project.instanceSettings?.map(endpoint),
    namedLinks,
    layout: {
      ...layout, topology,
      physical: layout?.physical?.map(item => ({ ...endpoint(item), enclosurePath: remap(item.enclosurePath) })),
      topologyFrames: layout?.topologyFrames?.map(item => ({ ...item, modulePath: remap(item.modulePath) })),
    },
  }, remap);
}
