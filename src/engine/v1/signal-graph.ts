import type { OpticalChannelId } from '../../model/v1/channels';
import type { OpticalRoute, Transfer } from '../../model/v1/device';
import type { CableCoreRef, Connection, LocalEndpointRef } from '../../model/v1/topology';
import type { ConnectionRef, EndpointRef, InstancePath, PortDefinition, Project } from '../../model/v1/types';
import { resolveHierarchy } from './hierarchy';
import type { ResolvedInstance } from './hierarchy';

export type SignalPort = Readonly<{
  ref: EndpointRef;
  definition: PortDefinition;
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
      ports.set(signalPortKey(ref), { ref, definition: port, unmapped: definition.kind === 'module' && !mappedIds.has(port.id) });
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
    } else if (transfer?.kind === 'eo' || transfer?.kind === 'dml') {
      channels = { kind: 'enter', channelIds };
    } else if (transfer?.kind === 'oe') {
      channels = { kind: 'exit', channelIds };
    } else if (from.definition.type === 'OPTICAL') {
      channels = { kind: 'preserve', channelIds };
    }
    edges.push({ from, to, source, channels, ...(supply && { supply }) });
  }

  for (const { instancePath, definition, switchState } of instances) {
    if (definition.kind === 'module') {
      for (const mapping of definition.portMappings ?? []) {
        const outer = portAt(instancePath, mapping.portId);
        const inner = localPort(instancePath, mapping.target);
        const [from, to] = outer.definition.direction === 'in' ? [outer, inner] : [inner, outer];
        addEdge(from, to, { kind: 'portMapping', publicPort: outer.ref });
      }
      for (const connection of definition.connections ?? []) {
        addEdge(localPort(instancePath, connection.from), localPort(instancePath, connection.to), {
          kind: 'connection', ref: { scopePath: instancePath, connectionId: connection.id }, mediaKind: connection.mediaKind,
        });
      }
      for (const bundle of definition.cableBundles ?? []) {
        for (const core of bundle.cores) {
          if (!core.a.endpoint || !core.b.endpoint) continue;
          const a = localPort(instancePath, core.a.endpoint);
          const b = localPort(instancePath, core.b.endpoint);
          const [from, to] = a.definition.direction === 'out' ? [a, b] : [b, a];
          addEdge(from, to, {
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
      });
      switchState?.routes.forEach((route, index) => {
        addEdge(portAt(instancePath, route.fromPortId), portAt(instancePath, route.toPortId),
          { kind: 'switchRoute', stateId: switchState.id, index, route });
      });
    }
  }

  return { instances, ports, edges };
}
