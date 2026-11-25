import type { OpticalChannelId } from '../../model/v1/channels';
import type { OpticalRoute, Transfer } from '../../model/v1/device';
import type { CableCoreRef, Connection, LocalEndpointRef } from '../../model/v1/topology';
import { canConnect, supportsDirection } from '../../model/v1/types';
import type { ConnectionRef, EndpointRef, InstancePath, PortDefinition, PortFlow, Project } from '../../model/v1/types';
import { resolveHierarchy } from './hierarchy';
import type { ResolvedInstance } from './hierarchy';

export type SignalPort = Readonly<{
  ref: EndpointRef;
  definition: PortDefinition;
  modulePort: boolean;
  unmapped: boolean;
}>;

export type SignalChannels =
  | { kind: 'none' }
  /** A missing list leaves the legal channel IDs unrestricted. */
  | { kind: 'preserve' | 'enter' | 'exit'; channelIds?: readonly OpticalChannelId[] }
  | { kind: 'convert'; fromChannelId: OpticalChannelId; toChannelId: OpticalChannelId };

export type SignalEdgeSource =
  | { kind: 'portMapping'; publicPort: EndpointRef }
  | { kind: 'connection'; ref: ConnectionRef; mediaKind?: Connection['mediaKind'] }
  | { kind: 'cableCore'; ref: CableCoreRef; aPin: number; bPin: number }
  | { kind: 'transfer'; index: number; transfer: Transfer }
  | { kind: 'switchRoute'; stateId: string; index: number; route: OpticalRoute };

export type SignalEdge = Readonly<{
  from: SignalPort;
  to: SignalPort;
  channels: SignalChannels;
  source: SignalEdgeSource;
  /** A separate optical input required by an EO transfer. */
  supply?: SignalPort;
}>;

export type SignalGraph = Readonly<{
  instances: readonly ResolvedInstance[];
  ports: ReadonlyMap<string, SignalPort>;
  edges: readonly SignalEdge[];
}>;

/** A wire leaves an output face and arrives at an input face; a mapping preserves that face. */
export function portFlowAt(edge: SignalEdge, port: SignalPort): PortFlow {
  if (edge.source.kind === 'portMapping') return edge.from.ref === edge.source.publicPort ? 'in' : 'out';
  if (edge.source.kind === 'connection' || edge.source.kind === 'cableCore') return edge.from === port ? 'out' : 'in';
  return edge.from === port ? 'in' : 'out';
}

export function isDigitalEdge(edge: SignalEdge) {
  return edge.source.kind === 'transfer' && (edge.source.transfer.kind === 'digitalTx' || edge.source.transfer.kind === 'digitalRx');
}

/** Identifies mux/demux ports by their channel-specific routes, independent of device names or icons. */
export function channelRoutingPorts(edges: Iterable<SignalEdge>) {
  const filters = { from: new Map<SignalPort, string>(), to: new Map<SignalPort, string>() };
  const ports = { from: new Set<SignalPort>(), to: new Set<SignalPort>() };
  for (const edge of edges) {
    if (edge.source.kind !== 'switchRoute' && !(edge.source.kind === 'transfer'
      && (edge.source.transfer.kind === 'optical' || edge.source.transfer.kind === 'wavelengthConversion'))) continue;
    for (const end of ['from', 'to'] as const) {
      const port = edge[end];
      const filter = edge.channels.kind === 'convert' ? [end === 'from' ? edge.channels.fromChannelId : edge.channels.toChannelId]
        : edge.channels.kind === 'preserve' ? edge.channels.channelIds : undefined;
      const key = filter ? [...filter].sort().join(',') : '';
      if (filters[end].has(port) && filters[end].get(port) !== key) ports[end].add(port);
      filters[end].set(port, key);
    }
  }
  return ports;
}

export function signalPortKey({ instancePath, portId }: EndpointRef): string {
  return JSON.stringify([instancePath, portId]);
}

function intersectChannels(...filters: (readonly OpticalChannelId[] | undefined)[]): readonly OpticalChannelId[] | undefined {
  let channels: readonly OpticalChannelId[] | undefined;
  for (const filter of filters) {
    if (filter) channels = channels ? channels.filter(id => filter.includes(id)) : filter;
  }
  return channels;
}

/** Builds a directed graph of the current snapshot without tracing or evaluating signals. */
export function buildSignalGraph(project: Project): SignalGraph {
  const instances = [...resolveHierarchy(project).walkInstances()];
  const ports = new Map<string, SignalPort>();
  const edges: SignalEdge[] = [];

  for (const { instancePath, definition } of instances) {
    const mappedIds = new Set(definition.kind === 'module' ? definition.portMappings?.map(mapping => mapping.portId) : []);
    for (const port of definition.ports) {
      const ref = { instancePath, portId: port.id };
      ports.set(signalPortKey(ref), { ref, definition: port, modulePort: definition.kind === 'module',
        unmapped: definition.kind === 'module' && !mappedIds.has(port.id) });
    }
  }

  // The hierarchy validator guarantees that each declared edge endpoint exists.
  const portAt = (instancePath: InstancePath, portId: string) => ports.get(signalPortKey({ instancePath, portId }))!;
  const localPort = (scopePath: InstancePath, { instanceId, portId }: LocalEndpointRef) =>
    portAt([...scopePath, instanceId], portId);

  function addEdge(from: SignalPort, to: SignalPort, source: SignalEdgeSource, supply?: SignalPort) {
    const transfer = source.kind === 'transfer' ? source.transfer : undefined;
    const declared = source.kind === 'switchRoute' ? source.route.channelIds
      : transfer && 'channelIds' in transfer ? transfer.channelIds : undefined;
    const channelIds = intersectChannels(from.definition.channelIds, to.definition.channelIds, declared, supply?.definition.channelIds);
    let channels: SignalChannels = { kind: 'none' };
    if (transfer?.kind === 'wavelengthConversion') {
      channels = { kind: 'convert', fromChannelId: transfer.fromChannelId, toChannelId: transfer.toChannelId };
    } else if (transfer?.kind === 'eo' || transfer?.kind === 'dml' || transfer?.kind === 'digitalTx') {
      channels = { kind: 'enter', channelIds };
    } else if (transfer?.kind === 'oe' || transfer?.kind === 'digitalRx') {
      channels = { kind: 'exit', channelIds };
    } else if (from.definition.type === 'OPTICAL') {
      channels = { kind: 'preserve', channelIds };
    }
    edges.push({ from, to, source, channels, ...(supply && { supply }) });
  }

  function addWire(a: SignalPort, b: SignalPort, source: SignalEdgeSource) {
    if (canConnect(a.definition.direction, b.definition.direction)) addEdge(a, b, source);
    if (canConnect(b.definition.direction, a.definition.direction)) addEdge(b, a, source);
  }

  for (const { instancePath, definition, switchState } of instances) {
    if (definition.kind === 'module') {
      for (const mapping of definition.portMappings ?? []) {
        const outer = portAt(instancePath, mapping.portId);
        const inner = localPort(instancePath, mapping.target);
        const source = { kind: 'portMapping', publicPort: outer.ref } as const;
        if (supportsDirection(outer.definition.direction, 'in')) addEdge(outer, inner, source);
        if (supportsDirection(outer.definition.direction, 'out')) addEdge(inner, outer, source);
      }
      for (const connection of definition.connections ?? []) {
        addWire(localPort(instancePath, connection.from), localPort(instancePath, connection.to), {
          kind: 'connection', ref: { scopePath: instancePath, connectionId: connection.id }, mediaKind: connection.mediaKind,
        });
      }
      for (const bundle of definition.cableBundles ?? []) {
        for (const core of bundle.cores) {
          if (!core.a.endpoint || !core.b.endpoint) continue;
          const a = localPort(instancePath, core.a.endpoint);
          const b = localPort(instancePath, core.b.endpoint);
          addWire(a, b, {
            kind: 'cableCore', ref: { scopePath: instancePath, bundleId: bundle.id, coreId: core.id },
            aPin: core.a.pin, bPin: core.b.pin,
          });
        }
      }
    } else {
      definition.transfers?.forEach((transfer, index) => {
        const supply = transfer.kind === 'eo' && transfer.supplyPortId !== undefined
          ? portAt(instancePath, transfer.supplyPortId) : undefined;
        addEdge(portAt(instancePath, transfer.fromPortId), portAt(instancePath, transfer.toPortId),
          { kind: 'transfer', index, transfer }, supply);
        if (transfer.kind === 'splitter') {
          addEdge(portAt(instancePath, transfer.fromPortId), portAt(instancePath, transfer.secondPortId), { kind: 'transfer', index, transfer });
        }
      });
      switchState?.routes.forEach((route, index) => {
        addEdge(portAt(instancePath, route.fromPortId), portAt(instancePath, route.toPortId),
          { kind: 'switchRoute', stateId: switchState.id, index, route });
      });
    }
  }

  return { instances, ports, edges };
}
