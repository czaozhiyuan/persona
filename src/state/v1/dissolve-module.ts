import { retainWireRoutes } from './wire-routes';
import { portDisplayName } from '../../model/v1/display-names';
import { resolveHierarchy } from '../../engine/v1/hierarchy';
import type { LocalEndpointRef } from '../../model/v1/topology';
import { isPowerPort, mappingId, type PortMapping } from '../../model/v1/types';
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
  if (conflict) throw new Error(`上一级已有实例引用冲突，无法安全提升「${conflict.name}」。`);

  const occurrences = [...hierarchy.walkInstances()].filter(item => item.definition.id === parent.id);
  const containerScopes = new Map(occurrences.map(({ instancePath }) => [key([...instancePath, slotId]), instancePath]));
  const isContainer = (path: InstancePath) => containerScopes.has(key(path));
  const parentScopes = new Set(occurrences.map(item => key(item.instancePath)));
  const layout = project.layout;
  const enclosed = layout?.physical?.find(item => isContainer(item.enclosurePath));
  if (enclosed) {
    const name = hierarchy.resolveInstance(enclosed.instancePath)?.instance?.name;
    throw new Error(`待解散模块仍是「${name ?? '未找到的对象'}」的物理机箱，请先调整物理放置。`);
  }

  const definitions = new Map([...project.moduleDefinitions, ...project.componentDefinitions].map(item => [item.id, item]));
  const children = new Map(container.instances.map(item => [item.id, item]));
  const ports = new Map(container.ports.map(port => [port.id, port]));
  function checkAlias(portId: string, target: LocalEndpointRef) {
    const boundary = ports.get(portId)!;
    const inner = definitions.get(children.get(target.instanceId)!.definitionId)!.ports.find(port => port.id === target.portId)!;
    if (unrestrictedAlias(boundary, inner)) return;
    const condition = boundary.inputVoltageV ? '标称输入电压' : boundary.outputVoltageV ? '输出电压' : boundary.inputRating ? '输入额定范围' : '光通道限制';
    throw new Error(`对外端口「${portDisplayName(boundary, true)}」设置了${condition}，解散会移除该约束。`);
  }

  const mappings = new Map<string, PortMapping[]>();
  for (const mapping of container.portMappings ?? []) {
    // An internal power source can energize the boundary even without an external wire.
    if (isPowerPort(ports.get(mapping.portId)?.type)) checkAlias(mapping.portId, mapping.target);
    const branches = mappings.get(mapping.portId) ?? [];
    branches.push(mapping);
    mappings.set(mapping.portId, branches);
  }
  const adjustedPorts = new Set<string>();
  function unwrap(ref: LocalEndpointRef): LocalEndpointRef {
    if (ref.instanceId !== slotId) return ref;
    const target = mappings.get(ref.portId)?.[0].target;
    if (!target) throw new Error(`对外端口「${portDisplayName(ports.get(ref.portId)!, true)}」仍被引用，但没有内部映射，无法解散。`);
    if (!isPowerPort(ports.get(ref.portId)?.type)) checkAlias(ref.portId, target);
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

  // Contract a removed power junction onto its enclosing public port when available.
  // Without an enclosing mapping the first internal terminal becomes the junction.
  const endpoint = (ref: LocalEndpointRef) => JSON.stringify([ref.instanceId, ref.portId]);
  const pair = (a: LocalEndpointRef, b: LocalEndpointRef) => JSON.stringify([endpoint(a), endpoint(b)].sort());
  const seenTargets = new Set<string>();
  const parentMappings = parent.portMappings?.flatMap(mapping => {
    const target = unwrap(mapping.target);
    const key = JSON.stringify([mapping.portId, endpoint(target)]);
    if (seenTargets.has(key)) return [];
    seenTargets.add(key);
    return [{ ...mapping, target }];
  });
  const mappingIds = new Set(parentMappings?.map(mappingId));
  const removedWires = new Map<string, string | undefined>();
  const pairs = new Map<string, string>();
  const powerAliases = new Set(parent.connections?.filter(wire =>
    [wire.from, wire.to].some(ref => ref.instanceId === slotId && isPowerPort(ports.get(ref.portId)?.type))).map(wire => wire.id));
  const connections = [...relocate(existingConnections, container.connections ?? [], connectionIds)];
  // Keep unchanged physical wires in preference to aliases converging onto the same two terminals.
  for (const wire of connections) {
    if (!powerAliases.has(wire.id)) pairs.set(pair(wire.from, wire.to), wire.id);
  }
  const kept = connections.filter(wire => {
    if (!powerAliases.has(wire.id)) return true;
    const key = pair(wire.from, wire.to);
    if (endpoint(wire.from) === endpoint(wire.to) || pairs.has(key)) {
      removedWires.set(wire.id, pairs.get(key));
      return false;
    }
    pairs.set(key, wire.id);
    return true;
  });
  const usedWireIds = new Set(connections.map(wire => wire.id));
  for (const [portId, branches] of mappings) {
    if (branches.length < 2) continue;
    const enclosing = parent.portMappings?.find(mapping => mapping.target.instanceId === slotId && mapping.target.portId === portId);
    const from = unwrap({ instanceId: slotId, portId });
    for (const branch of branches.slice(1)) {
      const to = branch.target;
      if (enclosing && parentMappings) {
        const key = JSON.stringify([enclosing.portId, endpoint(to)]);
        if (seenTargets.has(key)) continue;
        seenTargets.add(key);
        const id = availableId(mappingId(branch), mappingIds);
        mappingIds.add(id);
        parentMappings.push({ id, portId: enclosing.portId, target: to });
      } else if (!pairs.has(pair(from, to))) {
        const id = availableId(mappingId(branch), usedWireIds);
        usedWireIds.add(id);
        pairs.set(pair(from, to), id);
        kept.push({ id, from, to });
      }
    }
  }
  const combined: ModuleDefinition = {
    ...parent,
    instances: parent.instances.flatMap(item => item.id === slotId ? container.instances : [item]),
    connections: parent.connections || container.connections || kept.length ? kept : undefined,
    cableBundles: parent.cableBundles || container.cableBundles ? relocate(existingBundles, container.cableBundles ?? [], bundleIds) : undefined,
    portMappings: parentMappings,
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

  const candidate = retainWireRoutes(project, {
    ...project,
    moduleDefinitions: stillUsed ? moduleDefinitions : moduleDefinitions.filter(item => item.id !== container.id),
    namedLinks: project.namedLinks?.map(link => remapLinkReferences(link, remap, atPort, ref => {
      const scopePath = containerScopes.get(key(ref.scopePath));
      if (!scopePath) {
        if ('connectionId' in ref && parentScopes.has(key(ref.scopePath)) && removedWires.has(ref.connectionId)) {
          const id = removedWires.get(ref.connectionId);
          return id === undefined ? undefined : { ...ref, connectionId: id };
        }
        return { ...ref, scopePath: remap(ref.scopePath) };
      }
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
  }, remap);
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
