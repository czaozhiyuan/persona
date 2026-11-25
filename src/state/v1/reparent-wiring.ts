import type { ParameterMapping } from '../../model/v1/parameters';
import type { CableBundle, LocalEndpointRef } from '../../model/v1/topology';
import { isPowerPort } from '../../model/v1/types';
import type { ModuleDefinition, PortDefinition } from '../../model/v1/types';

export function availableId(base: string, used: ReadonlySet<string>): string {
  let id = base;
  for (let suffix = 2; used.has(id); suffix++) id = `${base}_${suffix}`;
  return id;
}

export const rewriteConnections = (connections: ModuleDefinition['connections'], rewrite: (ref: LocalEndpointRef) => LocalEndpointRef) =>
  connections?.map(connection => ({ ...connection, from: rewrite(connection.from), to: rewrite(connection.to) }));

export const rewriteBundles = (bundles: readonly CableBundle[] | undefined, rewrite: (ref: LocalEndpointRef) => LocalEndpointRef) =>
  bundles?.map(bundle => ({ ...bundle, cores: bundle.cores.map(core => ({
    ...core,
    a: core.a.endpoint ? { ...core.a, endpoint: rewrite(core.a.endpoint) } : core.a,
    b: core.b.endpoint ? { ...core.b, endpoint: rewrite(core.b.endpoint) } : core.b,
  })) }));

export function moveParametersDown(parent: ModuleDefinition, container: ModuleDefinition, slotId: string,
  moving: ReadonlySet<string>) {
  const parameters = [...(container.parameters ?? [])];
  const parameterIds = new Set(parameters.map(parameter => parameter.id));
  const forwarded = new Map<string, string>();
  const internal = [...(container.parameterMappings ?? [])];
  const external: ParameterMapping[] = [];
  for (const mapping of parent.parameterMappings ?? []) {
    if (!moving.has(mapping.target.instanceId)) {
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
  return {
    outer: { ...parent, parameterMappings: parent.parameterMappings && external },
    inner: { ...container, parameters: parameters.length ? parameters : container.parameters,
      parameterMappings: internal.length ? internal : container.parameterMappings },
  };
}

export function unrestrictedAlias(boundary: PortDefinition, target: PortDefinition): boolean {
  // Removing a boundary must not change the voltage, ratings, or channels of the old route.
  return !boundary.inputRating && !boundary.outputVoltageV && (!boundary.channelIds
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

export function moveParametersUp(parent: ModuleDefinition, container: ModuleDefinition, slotId: string,
  moving: ReadonlySet<string>, hasContainerOverride: (parameterId: string) => boolean) {
  const parentParameters = [...(parent.parameterMappings ?? [])];
  const containerParameters = container.parameterMappings?.filter(mapping => {
    if (!moving.has(mapping.target.instanceId)) return true;
    const parameterId = forwardedParameterSource(parent, container, slotId, mapping.parameterId, hasContainerOverride);
    parentParameters.push({ ...mapping, parameterId });
    return false;
  });
  return {
    outer: { ...parent, parameterMappings: parentParameters.length ? parentParameters : parent.parameterMappings },
    inner: { ...container, parameterMappings: containerParameters },
  };
}

export function moveLocalWiring(source: ModuleDefinition, destination: ModuleDefinition, moving: ReadonlySet<string>) {
  const isMoving = (ref?: LocalEndpointRef) => ref !== undefined && moving.has(ref.instanceId);
  const relocatedConnections = new Map<string, string>();
  const deletedConnections = new Set<string>();
  const relocatedBundles = new Map<string, string>();
  const disconnectedCores = new Map<string, Set<string>>();
  const destinationConnections = [...(destination.connections ?? [])];
  const destinationBundles = [...(destination.cableBundles ?? [])];
  const connectionIds = new Set(destinationConnections.map(wire => wire.id));
  const bundleIds = new Set(destinationBundles.map(bundle => bundle.id));
  let retained = 0;
  let disconnected = 0;

  const connections = source.connections?.filter(wire => {
    const from = isMoving(wire.from), to = isMoving(wire.to);
    if (!from && !to) return true;
    if (from && to) {
      const id = availableId(wire.id, connectionIds);
      connectionIds.add(id);
      relocatedConnections.set(wire.id, id);
      destinationConnections.push({ ...wire, id });
      retained++;
    } else {
      deletedConnections.add(wire.id);
      disconnected++;
    }
    return false;
  });

  const cableBundles = source.cableBundles?.flatMap(bundle => {
    const endpoints = bundle.cores.flatMap(core => [core.a.endpoint, core.b.endpoint])
      .filter(endpoint => endpoint !== undefined);
    if (!endpoints.some(isMoving)) return [bundle];
    if (endpoints.every(isMoving)) {
      const id = availableId(bundle.id, bundleIds);
      bundleIds.add(id);
      relocatedBundles.set(bundle.id, id);
      destinationBundles.push({ ...bundle, id });
      retained += bundle.cores.filter(core => core.a.endpoint && core.b.endpoint).length;
      return [];
    }

    const internal = bundle.cores.find(core => isMoving(core.a.endpoint) && isMoving(core.b.endpoint));
    if (internal) {
      throw new Error(`线束的纤芯（A:${internal.a.pin} / B:${internal.b.pin}）两端都随移，但线束还连接未移动的对象，无法安全拆分。请先调整线束附件。`);
    }

    const broken = new Set<string>();
    const cores = bundle.cores.map(core => {
      const a = isMoving(core.a.endpoint), b = isMoving(core.b.endpoint);
      if (!a && !b) return core;
      broken.add(core.id);
      if (core.a.endpoint && core.b.endpoint) disconnected++;
      return { ...core, a: a ? { pin: core.a.pin } : core.a, b: b ? { pin: core.b.pin } : core.b };
    });
    if (broken.size) disconnectedCores.set(bundle.id, broken);
    return [{ ...bundle, cores }];
  });

  const powerPorts = new Set(source.ports.filter(port => isPowerPort(port.type)).map(port => port.id));
  const portMappings = source.portMappings?.filter(mapping => {
    if (!isMoving(mapping.target)) return true;
    if (powerPorts.has(mapping.portId)) disconnected++;
    return false;
  });
  return {
    source: { ...source, connections, cableBundles, portMappings },
    destination: { ...destination,
      connections: destinationConnections.length ? destinationConnections : destination.connections,
      cableBundles: destinationBundles.length ? destinationBundles : destination.cableBundles },
    retained, disconnected, relocatedConnections, deletedConnections, relocatedBundles, disconnectedCores,
  };
}
