import type { ParameterMapping } from '../../model/v1/parameters';
import type { CableBundle, Connection, LocalEndpointRef } from '../../model/v1/topology';
import type { Instance, ModuleDefinition, PortDefinition, PortMapping } from '../../model/v1/types';

export function availableId(base: string, used: ReadonlySet<string>): string {
  let id = base;
  for (let suffix = 2; used.has(id); suffix++) id = `${base}_${suffix}`;
  return id;
}

function boundaryPorts(module: ModuleDefinition, children: ReadonlyMap<string, Instance>, portsOf: (id: string) => readonly PortDefinition[]) {
  const ports = [...module.ports];
  const mappings = [...(module.portMappings ?? [])];
  const ids = new Set(ports.map(port => port.id));
  const exposed = new Map<string, string>();
  return {
    ports, mappings,
    expose(ref: LocalEndpointRef): string {
      const key = JSON.stringify([ref.instanceId, ref.portId]);
      const existing = exposed.get(key);
      if (existing !== undefined) return existing;
      const child = children.get(ref.instanceId)!;
      const port = portsOf(child.definitionId).find(item => item.id === ref.portId)!;
      const id = availableId(port.id, ids);
      ids.add(id);
      exposed.set(key, id);
      ports.push({ id, name: `${child.name} · ${port.name ?? port.id}`, direction: port.direction, type: port.type,
        ...(port.channelIds && { channelIds: port.channelIds }) });
      mappings.push({ portId: id, target: ref });
      return id;
    },
  };
}

export const rewriteConnections = (connections: ModuleDefinition['connections'], rewrite: (ref: LocalEndpointRef) => LocalEndpointRef) =>
  connections?.map(connection => ({ ...connection, from: rewrite(connection.from), to: rewrite(connection.to) }));

export const rewriteBundles = (bundles: readonly CableBundle[] | undefined, rewrite: (ref: LocalEndpointRef) => LocalEndpointRef) =>
  bundles?.map(bundle => ({ ...bundle, cores: bundle.cores.map(core => ({
    ...core,
    a: core.a.endpoint ? { ...core.a, endpoint: rewrite(core.a.endpoint) } : core.a,
    b: core.b.endpoint ? { ...core.b, endpoint: rewrite(core.b.endpoint) } : core.b,
  })) }));

export function wireMoveDown(parent: ModuleDefinition, container: ModuleDefinition, slotId: string,
  moved: Instance, portsOf: (id: string) => readonly PortDefinition[]) {
  const boundary = boundaryPorts(container, new Map([[moved.id, moved]]), portsOf);
  const through = (ref: LocalEndpointRef) => ref.instanceId === moved.id
    ? { instanceId: slotId, portId: boundary.expose(ref) } : ref;
  const parameters = [...(container.parameters ?? [])];
  const parameterIds = new Set(parameters.map(parameter => parameter.id));
  const forwarded = new Map<string, string>();
  const internal = [...(container.parameterMappings ?? [])];
  const external: ParameterMapping[] = [];
  for (const mapping of parent.parameterMappings ?? []) {
    if (mapping.target.instanceId !== moved.id) {
      external.push(mapping);
      continue;
    }
    let id = forwarded.get(mapping.parameterId);
    if (id === undefined) {
      const source = parent.parameters!.find(parameter => parameter.id === mapping.parameterId)!;
      const { defaultValue: _default, ...parameter } = source;
      id = availableId(source.id, parameterIds);
      parameterIds.add(id);
      parameters.push({ ...parameter, id, overridable: true });
      forwarded.set(source.id, id);
      external.push({ parameterId: source.id, target: { instanceId: slotId, parameterId: id } });
    }
    internal.push({ ...mapping, parameterId: id });
  }
  const outer = {
    ...parent,
    connections: rewriteConnections(parent.connections, through),
    cableBundles: rewriteBundles(parent.cableBundles, through),
    portMappings: parent.portMappings?.map(mapping => ({ ...mapping, target: through(mapping.target) })),
    parameterMappings: parent.parameterMappings && external,
  };
  return {
    outer,
    inner: { ...container, ports: boundary.ports, portMappings: boundary.mappings,
      parameters: parameters.length ? parameters : container.parameters,
      parameterMappings: internal.length ? internal : container.parameterMappings },
  };
}

export function unrestrictedAlias(boundary: PortDefinition, target: PortDefinition): boolean {
  // Removing a boundary must not broaden the channels carried by the old route.
  return !boundary.inputRating && (!boundary.channelIds
    || !!target.channelIds?.every(channel => boundary.channelIds!.includes(channel)));
}

export function forwardedParameterSource(parent: ModuleDefinition, container: ModuleDefinition, slotId: string,
  parameterId: string, hasContainerOverride: (id: string) => boolean): string {
  const source = container.parameters!.find(parameter => parameter.id === parameterId)!;
  const incoming = parent.parameterMappings?.find(item =>
    item.target.instanceId === slotId && item.target.parameterId === source.id);
  if (!incoming || source.defaultValue !== undefined || hasContainerOverride(source.id)) {
    throw new Error(`模块参数「${source.name}」依赖本层默认值、覆盖值或本层来源，无法安全移出其映射目标。`);
  }
  return incoming.parameterId;
}

export function wireMoveUp(parent: ModuleDefinition, container: ModuleDefinition, slotId: string, moved: Instance,
  portsOf: (id: string) => readonly PortDefinition[], hasContainerOverride: (parameterId: string) => boolean) {
  const moving = (ref?: LocalEndpointRef) => ref?.instanceId === moved.id;
  const bundle = container.cableBundles?.find(item => item.cores.some(core => moving(core.a.endpoint) || moving(core.b.endpoint)));
  if (bundle) throw new Error(`线束「${bundle.id}」连接到待移出的实例，无法跨层拆分线束。`);

  const aliases = new Map<string, LocalEndpointRef>();
  const retainedMappings = container.portMappings?.filter(mapping => {
    if (!moving(mapping.target)) return true;
    const boundary = container.ports.find(port => port.id === mapping.portId)!;
    const target = portsOf(moved.definitionId).find(port => port.id === mapping.target.portId)!;
    if (!unrestrictedAlias(boundary, target)) {
      throw new Error(`对外端口「${boundary.id}」带有光通道或额定限制，移出会改变原有信号条件。`);
    }
    aliases.set(mapping.portId, mapping.target);
    return false;
  });
  const unwrap = (ref: LocalEndpointRef) => ref.instanceId === slotId ? aliases.get(ref.portId) ?? ref : ref;

  const children = new Map(container.instances.map(child => [child.id, child]));
  const boundary = boundaryPorts({ ...container, portMappings: retainedMappings }, children, portsOf);
  const through = (ref: LocalEndpointRef) => moving(ref) ? ref : { instanceId: slotId, portId: boundary.expose(ref) };
  const external = rewriteConnections(parent.connections, unwrap) ?? [];
  const usedWires = new Set(external.map(connection => connection.id));
  const relocated = new Map<string, string>();
  const internal: Connection[] = [];
  for (const wire of container.connections ?? []) {
    if (!moving(wire.from) && !moving(wire.to)) {
      internal.push(wire);
      continue;
    }
    const id = availableId(wire.id, usedWires);
    usedWires.add(id);
    relocated.set(wire.id, id);
    external.push({ ...wire, id, from: through(wire.from), to: through(wire.to) });
  }
  const parentParameters = [...(parent.parameterMappings ?? [])];
  const containerParameters = container.parameterMappings?.filter(mapping => {
    if (mapping.target.instanceId !== moved.id) return true;
    const parameterId = forwardedParameterSource(parent, container, slotId, mapping.parameterId, hasContainerOverride);
    parentParameters.push({ ...mapping, parameterId });
    return false;
  });
  return {
    aliases, relocated,
    outer: {
      ...parent, connections: external.length ? external : parent.connections,
      cableBundles: rewriteBundles(parent.cableBundles, unwrap),
      portMappings: parent.portMappings?.map(mapping => ({ ...mapping, target: unwrap(mapping.target) })),
      parameterMappings: parentParameters.length ? parentParameters : parent.parameterMappings,
    },
    inner: { ...container, ports: boundary.ports, portMappings: boundary.mappings,
      connections: container.connections && internal, parameterMappings: containerParameters },
  };
}
