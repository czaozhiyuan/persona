import { resolveOpticalChannel } from '../../model/v1/channels';
import type { OpticalChannelId } from '../../model/v1/channels';
import type { CableCoreRef, ConversionBinding, NamedLink } from '../../model/v1/topology';
import type { ConnectionRef, EndpointRef, InstancePath, Project } from '../../model/v1/types';
import { validateNamedLinks } from '../../model/v1/validate-topology';
import { intersectCarrier, searchSignalPath } from './path-search';
import type { Carrier, SignalPath } from './path-search';
import { buildSignalGraph, signalPortKey } from './signal-graph';
import type { SignalEdge, SignalPort } from './signal-graph';

export type LocalPathRequest = { from: EndpointRef; to: EndpointRef; channelId?: OpticalChannelId };
export type PathOptions = {
  /** Optical outputs or public input boundaries explicitly supplied by the caller. */
  opticalSources?: readonly (EndpointRef & { channelId?: OpticalChannelId })[];
};

type ConversionStep = { kind: 'eo' | 'oe'; edgeIndex: number };
type BindingMatch = { binding: ConversionBinding; eoEdgeIndex?: number; oeEdgeIndex?: number; matched: boolean };
type SupplyBranch = { edgeIndex: number; endpoint: EndpointRef } & (
  | { status: 'resolved'; path: SignalPath }
  | { status: 'missing' | 'ambiguous' | 'feedback_loop' | 'search_limit' }
);

export type PathTrace = SignalPath & {
  readonly conversions: readonly ConversionStep[];
  readonly bindings: readonly BindingMatch[];
  readonly supplies: readonly SupplyBranch[];
};

type FailureStatus = 'incomplete' | 'invalid_reference' | 'unreachable' | 'ambiguous' | 'feedback_loop' | 'search_limit';
export type PathResult =
  | { status: 'resolved'; trace: PathTrace }
  | { status: FailureStatus; reason: string; endpoint?: EndpointRef; trace?: PathTrace };

type RequiredRef = ConnectionRef | CableCoreRef;

function requiredKey(ref: RequiredRef): string {
  return JSON.stringify('bundleId' in ref
    ? [ref.scopePath, ref.bundleId, ref.coreId]
    : [ref.scopePath, ref.connectionId]);
}

function inside(scope: InstancePath, path: InstancePath): boolean {
  return scope.length < path.length && scope.every((id, index) => id === path[index]);
}

/** Creates independent queries over a validated V1 project snapshot. */
export function createPathResolver(project: Project) {
  const graph = buildSignalGraph(project);
  const scopes = new Map(graph.instances.map(instance => [JSON.stringify(instance.instancePath), instance.definition]));
  const profiles = new Map(project.conversionProfiles?.map(profile => [profile.id, profile]));
  const edgeRefs = new Map<string, SignalEdge>();
  const outgoing = new Map<SignalPort, SignalEdge[]>();
  const incoming = new Map<SignalPort, SignalEdge[]>();
  const mappings = new Map<string, SignalEdge>();

  for (const edge of graph.edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from)!.push(edge);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    incoming.get(edge.to)!.push(edge);
    const source = edge.source;
    if (source.kind === 'connection' || source.kind === 'cableCore') edgeRefs.set(requiredKey(source.ref), edge);
    if (source.kind === 'portMapping') mappings.set(signalPortKey(source.publicPort), edge);
  }

  const getPort = (ref: EndpointRef) => graph.ports.get(signalPortKey(ref));

  function followBoundary(start: SignalPort, required: SignalEdge[]): SignalPort {
    let port = start;
    for (let edge = mappings.get(signalPortKey(port.ref)); edge; edge = mappings.get(signalPortKey(port.ref))) {
      required.push(edge);
      port = edge.from === port ? edge.to : edge.from;
    }
    return port;
  }

  function traceSupplies(path: SignalPath, sources: ReadonlyMap<SignalPort, Carrier>, bindings: readonly ConversionBinding[]): PathResult {
    const steps = [...path.steps];
    const conversions: ConversionStep[] = [];
    const supplies: SupplyBranch[] = [];
    for (const [edgeIndex, edge] of path.edges.entries()) {
      if (edge.source.kind !== 'transfer') continue;
      const kind = edge.source.transfer.kind;
      if (kind !== 'eo' && kind !== 'oe') continue;
      conversions.push({ kind, edgeIndex });
      if (!edge.supply) continue;

      const supply = searchSignalPath({
        starts: [...sources.keys()], startCarriers: sources, target: edge.supply, adjacent: outgoing, carrier: undefined,
        targetCarrier: steps[edgeIndex + 1].channelIds, opticalOnly: true,
      });
      const endpoint = edge.supply.ref;
      if (supply.status !== 'resolved') {
        supplies.push({ edgeIndex, endpoint, status: supply.status === 'unreachable' ? 'missing' : supply.status });
        continue;
      }
      supplies.push({ edgeIndex, endpoint, status: 'resolved', path: supply.path });
      const channelIds = supply.path.steps.at(-1)?.channelIds;
      for (let i = edgeIndex + 1; i < steps.length; i++) {
        steps[i] = { ...steps[i], channelIds: intersectCarrier(steps[i].channelIds, channelIds) };
        if (path.edges[i]?.channels.kind !== 'preserve') break;
      }
    }
    const matches = bindings.map(binding => {
      const indexOf = (kind: 'eo' | 'oe') => conversions.findIndex(step => {
        if (step.kind !== kind) return false;
        const edge = path.edges[step.edgeIndex];
        const boundary = binding[kind];
        return signalPortKey(edge.from.ref) === signalPortKey({ instancePath: boundary.instancePath, portId: boundary.fromPortId })
          && edge.to.ref.portId === boundary.toPortId;
      });
      const eo = indexOf('eo');
      const oe = indexOf('oe');
      return { binding, eoEdgeIndex: conversions[eo]?.edgeIndex, oeEdgeIndex: conversions[oe]?.edgeIndex,
        matched: eo >= 0 && oe === eo + 1 };
    });
    const trace = { steps, edges: path.edges, conversions, bindings: matches, supplies };
    const failure = supplies.find(supply => supply.status !== 'resolved');
    if (failure) {
      const status = failure.status === 'missing' ? 'unreachable' : failure.status;
      const reason = failure.status === 'missing' ? 'No supplied optical path reaches the EO input on a compatible channel.'
        : failure.status === 'ambiguous' ? 'More than one optical supply path reaches the EO input.'
        : failure.status === 'feedback_loop' ? 'Feedback in the optical supply path is unsupported.'
        : 'The optical supply search exceeded its resource limit.';
      return { status, reason, endpoint: failure.endpoint, trace };
    }
    return { status: 'resolved', trace };
  }

  function resolve(
    request: LocalPathRequest, options: PathOptions, link?: NamedLink,
  ): PathResult {
    let from = getPort(request.from);
    let to = getPort(request.to);
    if (!from || !to) {
      return { status: 'invalid_reference', reason: 'The path endpoint does not exist.', endpoint: from ? request.to : request.from };
    }
    if (request.channelId !== undefined && !resolveOpticalChannel(request.channelId)) {
      return { status: 'invalid_reference', reason: `Unknown optical channel "${request.channelId}".` };
    }
    const sources = new Map<SignalPort, Carrier>();
    for (const ref of options.opticalSources ?? []) {
      const port = getPort(ref);
      const scope = scopes.get(JSON.stringify(ref.instancePath));
      if (port?.definition.type !== 'OPTICAL' || !scope
        || (scope.kind === 'module' ? port.definition.direction !== 'in' : port.definition.direction !== 'out')) {
        return { status: 'invalid_reference', endpoint: ref, reason: 'Supply sources must be optical device outputs or module inputs.' };
      }
      if (ref.channelId !== undefined && !resolveOpticalChannel(ref.channelId)) {
        return { status: 'invalid_reference', endpoint: ref, reason: `Unknown optical source channel "${ref.channelId}".` };
      }
      if (ref.channelId === undefined || (sources.has(port) && sources.get(port) === undefined)) sources.set(port, undefined);
      else sources.set(port, [...new Set([...(sources.get(port) ?? []), ref.channelId])]);
    }
    const requiredEdges: SignalEdge[] = [];
    if (link) {
      if (from.definition.direction === 'out') from = followBoundary(from, requiredEdges);
      if (to.definition.direction === 'in') to = followBoundary(to, requiredEdges);
      const open = from.unmapped ? from : to.unmapped ? to : undefined;
      if (open) return { status: 'incomplete', endpoint: open.ref, reason: 'A required module port has no internal mapping.' };
    }
    for (const ref of link?.via ?? []) {
      const edge = edgeRefs.get(requiredKey(ref));
      // An existing, partially attached fibre is valid project data but cannot carry the path.
      if (!edge) return { status: 'unreachable', reason: `Required fibre is open: ${requiredKey(ref)}.` };
      requiredEdges.push(edge);
    }
    const required = new Map([...new Set(requiredEdges)].map((edge, index) => [edge, 1n << BigInt(index)]));
    const carrier: Carrier = request.channelId === undefined ? undefined : [request.channelId];
    const result = searchSignalPath({
      starts: [from], target: to, adjacent: outgoing, carrier, required, allRequired: (1n << BigInt(required.size)) - 1n,
    });
    switch (result.status) {
      case 'resolved': return traceSupplies(result.path, sources, link?.conversionBindings ?? []);
      case 'ambiguous': return { status: 'ambiguous', reason: 'Multiple paths satisfy the endpoints and routing constraints.' };
      case 'feedback_loop': return { status: 'feedback_loop', endpoint: result.endpoint.ref, reason: 'Feedback on the requested path is unsupported.' };
      case 'search_limit': return { status: 'search_limit', reason: 'The path search exceeded its resource limit.' };
      case 'unreachable': {
        if (!result.reached.has(to)) {
          const reverse = searchSignalPath({ starts: [to], adjacent: incoming, carrier: undefined, reverse: true });
          if (reverse.status === 'search_limit') return { status: 'search_limit', reason: 'The mapping diagnostic exceeded its resource limit.' };
          if (reverse.status === 'unreachable') {
            const forwardPorts = [...result.reached];
            const reversePorts = [...reverse.reached];
            const inputs = forwardPorts.filter(port => port.unmapped && port.definition.direction === 'in');
            const outputs = reversePorts.filter(port => port.unmapped && port.definition.direction === 'out');
            const open = inputs.find(port => reversePorts.some(other => inside(port.ref.instancePath, other.ref.instancePath))
                || outputs.some(other => JSON.stringify(port.ref.instancePath) === JSON.stringify(other.ref.instancePath)))
              ?? outputs.find(port => forwardPorts.some(other => inside(port.ref.instancePath, other.ref.instancePath)));
            if (open) return { status: 'incomplete', endpoint: open.ref, reason: 'A required module port has no internal mapping.' };
          }
        }
        return { status: 'unreachable', reason: 'No path satisfies the endpoints and routing constraints.' };
      }
    }
  }

  function resolveNamedLink(link: NamedLink, options: PathOptions = {}): PathResult {
    try {
      validateNamedLinks([link], profiles, path => scopes.get(JSON.stringify(path)));
    } catch (error) {
      return { status: 'invalid_reference', reason: (error as Error).message };
    }
    if (!link.from || !link.to) return { status: 'incomplete', reason: 'A named link requires both endpoints.' };
    return resolve({ from: link.from, to: link.to, channelId: link.channelId }, options, link);
  }

  function resolveLocalPath(request: LocalPathRequest, options: PathOptions = {}): PathResult {
    return resolve(request, options);
  }

  return { graph, resolveNamedLink, resolveLocalPath };
}
