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
      const reason = failure.status === 'missing' ? '没有供光路径经兼容通道到达调制器的输入端口。'
        : failure.status === 'ambiguous' ? '有多条供光路径到达调制器的输入端口。'
        : failure.status === 'feedback_loop' ? '不支持供光路径中的反馈回路。'
        : '供光路径搜索超出资源上限。';
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
      return { status: 'invalid_reference', reason: '路径端点不存在。', endpoint: from ? request.to : request.from };
    }
    if (request.channelId !== undefined && !resolveOpticalChannel(request.channelId)) {
      return { status: 'invalid_reference', reason: `未知光通道「${request.channelId}」。` };
    }
    const sources = new Map<SignalPort, Carrier>();
    for (const ref of options.opticalSources ?? []) {
      const port = getPort(ref);
      const scope = scopes.get(JSON.stringify(ref.instancePath));
      if (port?.definition.type !== 'OPTICAL' || !scope
        || (scope.kind === 'module' ? port.definition.direction !== 'in' : port.definition.direction !== 'out')) {
        return { status: 'invalid_reference', endpoint: ref, reason: '供光源必须位于器件的光输出端口或模块的光输入端口。' };
      }
      if (ref.channelId !== undefined && !resolveOpticalChannel(ref.channelId)) {
        return { status: 'invalid_reference', endpoint: ref, reason: `未知光源通道「${ref.channelId}」。` };
      }
      if (ref.channelId === undefined || (sources.has(port) && sources.get(port) === undefined)) sources.set(port, undefined);
      else sources.set(port, [...new Set([...(sources.get(port) ?? []), ref.channelId])]);
    }
    const requiredEdges: SignalEdge[] = [];
    if (link) {
      if (from.definition.direction === 'out') from = followBoundary(from, requiredEdges);
      if (to.definition.direction === 'in') to = followBoundary(to, requiredEdges);
      const open = from.unmapped ? from : to.unmapped ? to : undefined;
      if (open) return { status: 'incomplete', endpoint: open.ref, reason: '路径所需的模块端口缺少内部映射。' };
    }
    for (const ref of link?.via ?? []) {
      const edge = edgeRefs.get(requiredKey(ref));
      // An existing, partially attached fibre is valid project data but cannot carry the path.
      if (!edge) return { status: 'unreachable', reason: `必经纤芯未接通：${requiredKey(ref)}。` };
      requiredEdges.push(edge);
    }
    const required = new Map([...new Set(requiredEdges)].map((edge, index) => [edge, 1n << BigInt(index)]));
    const carrier: Carrier = request.channelId === undefined ? undefined : [request.channelId];
    const result = searchSignalPath({
      starts: [from], target: to, adjacent: outgoing, carrier, required, allRequired: (1n << BigInt(required.size)) - 1n,
    });
    switch (result.status) {
      case 'resolved': return traceSupplies(result.path, sources, link?.conversionBindings ?? []);
      case 'ambiguous': return { status: 'ambiguous', reason: '有多条路径满足端点与路由约束。' };
      case 'feedback_loop': return { status: 'feedback_loop', endpoint: result.endpoint.ref, reason: '不支持所选路径中的反馈回路。' };
      case 'search_limit': return { status: 'search_limit', reason: '路径搜索超出资源上限。' };
      case 'unreachable': {
        if (!result.reached.has(to)) {
          const reverse = searchSignalPath({ starts: [to], adjacent: incoming, carrier: undefined, reverse: true });
          if (reverse.status === 'search_limit') return { status: 'search_limit', reason: '端口映射诊断超出资源上限。' };
          if (reverse.status === 'unreachable') {
            const forwardPorts = [...result.reached];
            const reversePorts = [...reverse.reached];
            const inputs = forwardPorts.filter(port => port.unmapped && port.definition.direction === 'in');
            const outputs = reversePorts.filter(port => port.unmapped && port.definition.direction === 'out');
            const open = inputs.find(port => reversePorts.some(other => inside(port.ref.instancePath, other.ref.instancePath))
                || outputs.some(other => JSON.stringify(port.ref.instancePath) === JSON.stringify(other.ref.instancePath)))
              ?? outputs.find(port => forwardPorts.some(other => inside(port.ref.instancePath, other.ref.instancePath)));
            if (open) return { status: 'incomplete', endpoint: open.ref, reason: '路径所需的模块端口缺少内部映射。' };
          }
        }
        return { status: 'unreachable', reason: '没有路径满足端点与路由约束。' };
      }
    }
  }

  function resolveNamedLink(link: NamedLink, options: PathOptions = {}): PathResult {
    try {
      validateNamedLinks([link], profiles, path => scopes.get(JSON.stringify(path)));
    } catch (error) {
      return { status: 'invalid_reference', reason: (error as Error).message };
    }
    if (!link.from || !link.to) return { status: 'incomplete', reason: '尚未连接：请设置链路起点和终点。' };
    return resolve({ from: link.from, to: link.to, channelId: link.channelId }, options, link);
  }

  function resolveLocalPath(request: LocalPathRequest, options: PathOptions = {}): PathResult {
    return resolve(request, options);
  }

  return { graph, resolveNamedLink, resolveLocalPath };
}
