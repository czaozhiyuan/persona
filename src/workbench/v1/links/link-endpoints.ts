import type { createPathResolver } from '../../../engine/v1/path-resolver';
import { signalPortKey } from '../../../engine/v1/signal-graph';
import type { SignalPort } from '../../../engine/v1/signal-graph';
import type { OpticalChannelId } from '../../../model/v1/channels';
import { isPowerPort, supportsDirection } from '../../../model/v1/types';
import type { EndpointRef, PortDirection, PortFlow } from '../../../model/v1/types';
import type { Option } from './link-options';

type Roles = Map<string, PortDirection>;

function addRole(roles: Roles, key: string, flow: PortFlow) {
  roles.set(key, roles.has(key) && roles.get(key) !== flow ? 'bidirectional' : flow);
}

export function createEndpointChoices({ graph, reachableFrom }: ReturnType<typeof createPathResolver>, all: Option<EndpointRef>[]) {
  const occupiedIn = new Set<SignalPort>(), occupiedOut = new Set<SignalPort>();
  const mapped = new Set<SignalPort>();
  const consumes = new Set<SignalPort>(), produces = new Set<SignalPort>();
  for (const { source, from, to, supply } of graph.edges) {
    if ((source.kind === 'connection' || source.kind === 'cableCore') && !source.ref.scopePath.length) {
      occupiedIn.add(to);
      occupiedOut.add(from);
    } else if (source.kind === 'portMapping' && !source.publicPort.instancePath.length) {
      const input = source.publicPort === from.ref;
      const child = input ? to : from;
      (input ? occupiedIn : occupiedOut).add(child);
      mapped.add(child);
    } else if (source.kind === 'transfer') {
      consumes.add(from);
      produces.add(to);
      if (supply) consumes.add(supply);
    }
  }
  // A blocked switch has no active graph edges, but its ports are still transmission ports.
  for (const { definition, instancePath } of graph.instances) {
    if (instancePath.length !== 1 || definition.kind !== 'component') continue;
    for (const state of definition.switchStates ?? []) for (const route of state.routes) {
      consumes.add(graph.ports.get(signalPortKey({ instancePath, portId: route.fromPortId }))!);
      produces.add(graph.ports.get(signalPortKey({ instancePath, portId: route.toPortId }))!);
    }
  }

  const starts: Roles = new Map(), ends: Roles = new Map();
  const signals = all.filter(({ key }) => !isPowerPort(graph.ports.get(key)!.definition.type));
  for (const { key, value } of signals) {
    if (value.instancePath.length > 1) continue;
    const port = graph.ports.get(key)!;
    const { direction, type, opticalEmitter } = port.definition;
    if (supportsDirection(direction, 'in') && !occupiedIn.has(port)) addRole(starts, key, 'in');
    if (supportsDirection(direction, 'out') && !occupiedOut.has(port)) addRole(ends, key, 'out');
    if (port.modulePort || mapped.has(port)) continue;
    if (!produces.has(port) && (opticalEmitter || (type !== 'OPTICAL' && direction === 'out'))) addRole(starts, key, 'out');
    if (occupiedIn.has(port) && !consumes.has(port)) addRole(ends, key, 'in');
  }
  const systemStarts = signals.filter(item => starts.has(item.key));
  const systemEnds = signals.filter(item => ends.has(item.key));

  return function endpointChoices(fromKey: string, channel: OpticalChannelId | undefined, local: boolean) {
    if (local) return { from: signals, to: signals, limited: false, systemEnds: ends };
    const from = graph.ports.get(fromKey);
    if (!from) return { from: systemStarts, to: systemEnds, limited: false, systemEnds: ends };
    const flow = starts.get(fromKey);
    const reached = reachableFrom(from, channel, flow === 'bidirectional' ? undefined : flow);
    const to = systemEnds.filter(({ key }) => {
      if (key === fromKey) return false;
      if (!reached) return true;
      const port = graph.ports.get(key)!;
      const role = ends.get(key)!;
      return !port.unmapped && ((supportsDirection(role, 'in') && reached.in.has(port))
        || (supportsDirection(role, 'out') && reached.out.has(port)));
    });
    return { from: systemStarts, to, limited: !reached, systemEnds: ends };
  };
}
