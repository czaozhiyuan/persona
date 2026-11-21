import { resolveHierarchy } from '../../engine/v1/hierarchy';
import type { LocalEndpointRef } from '../../model/v1/topology';
import type { EndpointRef, InstancePath, ModuleDefinition, Project, TopologyPlacement } from '../../model/v1/types';
import { validateProjectSnapshot } from '../../storage/v1/project-json';
import { availableId, forwardedParameterSource, rewriteBundles, rewriteConnections, unrestrictedAlias } from './reparent-wiring';
import { remapLinkReferences } from './remap-link-references';
import { defaultTopologyPosition } from './topology-position';

const key = (path: InstancePath) => JSON.stringify(path);

function dissolve(project: Project, source: InstancePath) {
  if (!source.length) throw new Error('根模块不能解散。');
  const hierarchy = resolveHierarchy(project);
  const parentPath = source.slice(0, -1);
  const parent = hierarchy.resolveInstance(parentPath)?.definition;
  const container = hierarchy.resolveInstance(source)?.definition;
  if (parent?.kind !== 'module' || container?.kind !== 'module') throw new Error('请选择一个非根模块。');
  const slotId = source.at(-1)!;
  const outerIds = new Set(parent.instances.filter(item => item.id !== slotId).map(item => item.id));
  const conflict = container.instances.find(item => outerIds.has(item.id) || item.id === slotId);
  if (conflict) throw new Error(`上一级已有实例 ID「${conflict.id}」，无法安全提升「${conflict.name}」。`);

  const occurrences = [...hierarchy.walkInstances()].filter(item => item.definition.id === parent.id);
  const containerScopes = new Map(occurrences.map(({ instancePath }) => [key([...instancePath, slotId]), instancePath]));
  const isContainer = (path: InstancePath) => containerScopes.has(key(path));
  const layout = project.layout;
  const enclosed = layout?.physical?.find(item => isContainer(item.enclosurePath));
  if (enclosed) {
    const name = hierarchy.resolveInstance(enclosed.instancePath)?.instance?.name;
    throw new Error(`待解散模块仍是「${name ?? enclosed.instancePath.join(' / ')}」的物理机箱，请先调整物理放置。`);
  }

  const definitions = new Map([...project.moduleDefinitions, ...project.componentDefinitions].map(item => [item.id, item]));
  const children = new Map(container.instances.map(item => [item.id, item]));
  const ports = new Map(container.ports.map(port => [port.id, port]));
  const mappings = new Map(container.portMappings?.map(mapping => [mapping.portId, mapping.target]));
  const adjustedPorts = new Set<string>();
  function unwrap(ref: LocalEndpointRef): LocalEndpointRef {
    if (ref.instanceId !== slotId) return ref;
    const target = mappings.get(ref.portId);
    if (!target) throw new Error(`对外端口「${ref.portId}」仍被引用，但没有内部映射，无法解散。`);
    const inner = definitions.get(children.get(target.instanceId)!.definitionId)!.ports.find(port => port.id === target.portId)!;
    if (!unrestrictedAlias(ports.get(ref.portId)!, inner)) {
      throw new Error(`对外端口「${ref.portId}」带有光通道或额定限制，解散会改变原有信号条件。`);
    }
    adjustedPorts.add(ref.portId);
    return target;
  }

  const outsideWires = parent.connections?.filter(wire => wire.from.instanceId === slotId || wire.to.instanceId === slotId).length ?? 0;
  const outsideCores = parent.cableBundles?.reduce((count, bundle) => count + bundle.cores.filter(core =>
    core.a.endpoint?.instanceId === slotId || core.b.endpoint?.instanceId === slotId).length, 0) ?? 0;
  const existingConnections = rewriteConnections(parent.connections, unwrap) ?? [];
  const existingBundles = rewriteBundles(parent.cableBundles, unwrap) ?? [];
  const connectionIds = new Map<string, string>();
  const bundleIds = new Map<string, string>();
  function relocate<T extends { id: string }>(outer: readonly T[], inner: readonly T[], ids: Map<string, string>): readonly T[] {
    const used = new Set(outer.map(item => item.id));
    return [...outer, ...inner.map(item => {
      const id = availableId(item.id, used);
      used.add(id);
      ids.set(item.id, id);
      return { ...item, id };
    })];
  }

  const slot = parent.instances.find(item => item.id === slotId)!;
  const overrides = new Set(project.instanceSettings?.filter(item => isContainer(item.instancePath))
    .flatMap(item => Object.keys(item.parameterOverrides ?? {})));
  const hasOverride = (id: string) => Object.hasOwn(slot.parameterOverrides ?? {}, id) || overrides.has(id);
  const parameterMappings = parent.parameterMappings?.filter(mapping => mapping.target.instanceId !== slotId) ?? [];
  for (const mapping of container.parameterMappings ?? []) {
    const parameterId = forwardedParameterSource(parent, container, slotId, mapping.parameterId, hasOverride);
    parameterMappings.push({ ...mapping, parameterId });
  }

  const combined: ModuleDefinition = {
    ...parent,
    instances: parent.instances.flatMap(item => item.id === slotId ? container.instances : [item]),
    connections: parent.connections || container.connections ? relocate(existingConnections, container.connections ?? [], connectionIds) : undefined,
    cableBundles: parent.cableBundles || container.cableBundles ? relocate(existingBundles, container.cableBundles ?? [], bundleIds) : undefined,
    portMappings: parent.portMappings?.map(mapping => ({ ...mapping, target: unwrap(mapping.target) })),
    parameterMappings: parent.parameterMappings || container.parameterMappings ? parameterMappings : undefined,
  };
  const moduleDefinitions = project.moduleDefinitions.map(item => item.id === parent.id ? combined : item);
  // Keep definitions still referenced by any slot, including slots in unused definitions.
  const stillUsed = moduleDefinitions.some(item => item.instances.some(instance => instance.definitionId === container.id));

  function remap(path: InstancePath): InstancePath {
    for (let depth = 1; depth < path.length; depth++) {
      const outer = containerScopes.get(key(path.slice(0, depth)));
      if (outer) return [...outer, ...path.slice(depth)];
    }
    return path;
  }

  function atPort(endpoint: EndpointRef): EndpointRef {
    const scope = containerScopes.get(key(endpoint.instancePath));
    if (!scope) return { ...endpoint, instancePath: remap(endpoint.instancePath) };
    const inner = unwrap({ instanceId: slotId, portId: endpoint.portId });
    return { instancePath: [...scope, inner.instanceId], portId: inner.portId };
  }

  let topology = layout?.topology?.filter(item => !isContainer(item.instancePath))
    .map(item => ({ ...item, instancePath: remap(item.instancePath) }));
  if (container.instances.length) {
    const positions = new Map(layout?.topology?.map(item => [key(item.instancePath), item]));
    const frames = new Map(layout?.topologyFrames?.map(item => [key(item.modulePath), item]));
    const topologyByPath = new Map(topology?.map(item => [key(item.instancePath), item]));
    for (const { instancePath: scope } of occurrences) {
      const oldContainer = [...scope, slotId];
      const direct = (module: ModuleDefinition, path: InstancePath): TopologyPlacement[] => module.instances.map((item, index) => {
        const instancePath = [...path, item.id];
        return positions.get(key(instancePath)) ?? { instancePath, ...defaultTopologyPosition(index, module.ports.length) };
      });
      const siblings = direct(parent, scope);
      const anchor = siblings.find(item => isContainer(item.instancePath))!;
      const inner = direct(container, oldContainer);
      const frame = frames.get(key(oldContainer));
      const origin = frame ?? { x: Math.min(...inner.map(item => item.x)), y: Math.min(...inner.map(item => item.y)) };
      for (const item of siblings) {
        if (!isContainer(item.instancePath)) topologyByPath.set(key(item.instancePath), item);
      }
      for (const item of inner) {
        const instancePath = remap(item.instancePath);
        topologyByPath.set(key(instancePath), { instancePath, x: anchor.x + item.x - origin.x, y: anchor.y + item.y - origin.y });
      }
    }
    topology = [...topologyByPath.values()];
  }

  const candidate: Project = {
    ...project,
    moduleDefinitions: stillUsed ? moduleDefinitions : moduleDefinitions.filter(item => item.id !== container.id),
    namedLinks: project.namedLinks?.map(link => remapLinkReferences(link, remap, atPort, ref => {
      const scopePath = containerScopes.get(key(ref.scopePath));
      if (!scopePath) return { ...ref, scopePath: remap(ref.scopePath) };
      return 'bundleId' in ref ? { ...ref, scopePath, bundleId: bundleIds.get(ref.bundleId)! }
        : { ...ref, scopePath, connectionId: connectionIds.get(ref.connectionId)! };
    })),
    instanceSettings: project.instanceSettings?.filter(item => !isContainer(item.instancePath))
      .map(item => ({ ...item, instancePath: remap(item.instancePath) })),
    layout: (layout || topology) && {
      ...layout, topology,
      physical: layout?.physical?.filter(item => !isContainer(item.instancePath)).map(item => ({
        ...item, instancePath: remap(item.instancePath), enclosurePath: remap(item.enclosurePath),
      })),
      topologyFrames: layout?.topologyFrames?.filter(item => !isContainer(item.modulePath))
        .map(item => ({ ...item, modulePath: remap(item.modulePath) })),
    },
  };
  validateProjectSnapshot(candidate);
  return {
    project: candidate, parentPath, source,
    children: container.instances.map(item => [...parentPath, item.id]),
    affected: occurrences.map(item => [...item.instancePath, slotId]),
    adjustedPorts: [...adjustedPorts],
    outsideWires, outsideCores, insideWires: container.connections?.length ?? 0, insideBundles: container.cableBundles?.length ?? 0,
  };
}

export function planDissolveModule(project: Project, source: InstancePath) {
  try {
    return { ok: true as const, ...dissolve(project, source) };
  } catch (error) {
    return { ok: false as const, message: (error as Error).message };
  }
}
