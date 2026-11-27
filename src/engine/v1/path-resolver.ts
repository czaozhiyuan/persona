import { addSourceCarrier, cascadedModulation, findOpticalSupply, incompatibleSource } from './optical-supply';
import { resolveOpticalChannel } from '../../model/v1/channels';
import type { OpticalChannelId } from '../../model/v1/channels';
import type { CableCoreRef, NamedLink } from '../../model/v1/topology';
import type { ConnectionRef, EndpointRef, InstancePath, PortFlow, Project } from '../../model/v1/types';
import { supportsDirection } from '../../model/v1/types';
import { validateNamedLinks } from '../../model/v1/validate-topology';
import { chooseRouteChannel, intersectCarrier, reachableSignalPorts, searchSignalPath, uniqueRoutePrefix } from './path-search';
import type { Carrier, SignalPath } from './path-search';
import { buildSignalGraph, isDigitalEdge, opticalSourceFlow, portFlowAt, signalPortKey } from './signal-graph';
import type { SignalEdge, SignalPort } from './signal-graph';

export type LocalPathRequest = { from: EndpointRef; to: EndpointRef; channelId?: OpticalChannelId };
export type PathOptions = {
  /** Optical outputs or public input boundaries explicitly supplied by the caller. */
  opticalSources?: readonly (EndpointRef & { channelId?: OpticalChannelId })[];
};

type ConversionStep = { kind: 'eo' | 'dml' | 'oe'; edgeIndex: number };
type SupplyBranch = { edgeIndex: number; endpoint: EndpointRef } & (
  | { status: 'resolved'; path: SignalPath }
  | { status: 'missing' | 'ambiguous' | 'feedback_loop' | 'search_limit'; channelPort?: EndpointRef; reason?: string }
);

export type PathTrace = SignalPath & {
  readonly conversions: readonly ConversionStep[];
  readonly supplies: readonly SupplyBranch[];
};

type FailureStatus = 'incomplete' | 'invalid_reference' | 'unreachable' | 'ambiguous' | 'feedback_loop' | 'search_limit';
export type PathResult =
  | { status: 'resolved'; trace: PathTrace }
  | { status: FailureStatus; reason: string; endpoint?: EndpointRef; trace?: PathTrace; digitalAccess?: readonly SignalEdge[] };

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
  const dmlEdges = graph.edges.filter(edge => edge.source.kind === 'transfer' && edge.source.transfer.kind === 'dml');
  const digitalEdges = graph.edges.filter(isDigitalEdge);
  const digitalOpticalPorts = new Set(digitalEdges.map(edge => edge.to.definition.type === 'OPTICAL' ? edge.to : edge.from));

  // A broken optical span can still have uniquely connected control wiring at either end.
  function digitalAccess(ref: EndpointRef, transmit: boolean) {
    const target = getPort(ref);
    if (target?.definition.type !== 'CONTROL') return;
    const face = (edge: SignalEdge) => transmit ? edge.from : edge.to;
    const boundaries = digitalEdges.filter(edge => face(edge).definition.type === 'CONTROL');
    const result = searchSignalPath({ starts: boundaries.map(face), target, carrier: undefined,
      adjacent: transmit ? incoming : outgoing, reverse: transmit, portType: 'CONTROL' });
    if (result.status === 'unreachable' || result.status === 'search_limit') return;
    if (result.status !== 'resolved') return [];
    const control = (transmit ? result.path.steps.at(-1)! : result.path.steps[0]).port;
    const matches = boundaries.filter(edge => face(edge) === control);
    return matches.length === 1 ? [...result.path.edges, matches[0]] : result.path.edges;
  }

  function followBoundary(start: SignalPort, required?: SignalEdge[]): SignalPort {
    let port = start;
    for (let edge = mappings.get(signalPortKey(port.ref)); edge; edge = mappings.get(signalPortKey(port.ref))) {
      required?.push(edge);
      port = edge.from === port ? edge.to : edge.from;
    }
    return port;
  }

  // Walk the CONTROL side of every converter together, preserving each bidirectional port face.
  function controlTerminals(boundaries: ReadonlySet<SignalPort>, exposed: ReadonlySet<SignalPort>, reverse: boolean) {
    const adjacent = reverse ? incoming : outgoing;
    const startFlow = reverse ? 'in' : 'out';
    const pending: { port: SignalPort; flow: PortFlow; alias: boolean }[] =
      [...boundaries].map(port => ({ port, flow: startFlow, alias: false }));
    const terminals: { port: SignalPort; flow: PortFlow }[] = [];
    const seen = { in: new Set<SignalPort>(), out: new Set<SignalPort>() };
    const seenAlias = { in: new Set<SignalPort>(), out: new Set<SignalPort>() };
    for (const state of pending) {
      const { port, flow } = state;
      const alias = state.alias || (flow === startFlow && exposed.has(port));
      const visited = (alias ? seenAlias : seen)[flow];
      if (visited.has(port)) continue;
      visited.add(port);
      const edges = adjacent.get(port)?.filter(edge => portFlowAt(edge, port) === flow);
      if (!edges?.length && !alias && !boundaries.has(port)) terminals.push({ port, flow });
      for (const edge of edges ?? []) {
        const next = reverse ? edge.from : edge.to;
        // Wires and mappings carry the same exposed signal. A control transfer reaches a distinct logical port.
        if (next.definition.type === 'CONTROL') pending.push({ port: next, flow: portFlowAt(edge, next),
          alias: alias && edge.source.kind !== 'transfer' });
      }
    }
    return terminals;
  }

  function routeConstraints(requiredEdges: readonly SignalEdge[]) {
    // Both directed realizations of a physical wire satisfy the same via constraint.
    const requiredRefs = new Map([...new Set(requiredEdges.map(edge => edge.source))].map((ref, index) => [ref, 1n << BigInt(index)]));
    const required = new Map<SignalEdge, bigint>();
    if (requiredRefs.size) for (const edge of graph.edges) {
      const bit = requiredRefs.get(edge.source);
      if (bit !== undefined) required.set(edge, bit);
    }
    return { required, allRequired: (1n << BigInt(requiredRefs.size)) - 1n };
  }

  function reachableFrom(start: SignalPort, channelId?: OpticalChannelId, startFlow?: PortFlow) {
    const mappings: SignalEdge[] = [];
    const from = start.definition.direction === 'out' ? followBoundary(start, mappings) : start;
    return reachableSignalPorts({
      starts: from.unmapped ? [] : [from], adjacent: outgoing, carrier: channelId && [channelId],
      startFlow: from.definition.opticalEmitter ? opticalSourceFlow : startFlow ? () => startFlow : undefined,
      ...routeConstraints(mappings),
    });
  }

  function partialDigitalSpan(link: NamedLink, access: readonly SignalEdge[], transmit: boolean, options: PathOptions, opposite?: readonly SignalEdge[]) {
    const boundary = access.find(isDigitalEdge);
    if (!boundary) return [];
    const port = transmit ? boundary.to : boundary.from;
    const via = (link.via ?? []).map(ref => edgeRefs.get(requiredKey(ref)));
    const missingVia = via.includes(undefined);
    if (missingVia && !opposite) return [];
    const known = new Set([...access, ...(opposite ?? [])].map(edge => edge.source));
    const remaining = via.filter((edge): edge is SignalEdge => !!edge && !known.has(edge.source));
    const sources = new Map<SignalPort, Carrier>();
    for (const source of options.opticalSources ?? []) {
      const emitter = getPort(source);
      if (emitter) addSourceCarrier(sources, emitter, source.channelId);
    }
    const allowed = 'channelIds' in boundary.channels ? boundary.channels.channelIds : undefined;
    const span = uniqueRoutePrefix({ starts: [port], adjacent: transmit ? outgoing : incoming, reverse: !transmit,
      portType: opposite ? 'OPTICAL' : undefined,
      carrier: intersectCarrier(link.channelId && [link.channelId], allowed), startCarriers: sources,
      startFlow: () => portFlowAt(boundary, port), ...routeConstraints(remaining),
    }, edge => !(edge.from.definition.type === 'OPTICAL' && edge.to.definition.type === 'OPTICAL'
      || isDigitalEdge(edge) || edge.source.kind === 'portMapping' && edge.from.definition.type === 'CONTROL'), !!opposite);
    const end = span.at(-1);
    const endPort = transmit ? end?.to : end?.from;
    if (opposite && endPort && digitalOpticalPorts.has(endPort)) {
      // A physically complete run to a different converter or through the wrong wire is an alternate route.
      const peer = opposite.find(isDigitalEdge);
      for (const edge of span) known.add(edge.source);
      if (endPort !== (transmit ? peer?.from : peer?.to) || missingVia || remaining.some(edge => !known.has(edge.source))) {
        const firstWire = span.findIndex(edge => edge.source.kind !== 'portMapping');
        if (firstWire >= 0) return span.slice(0, firstWire);
      }
    }
    return span;
  }

  function traceSupplies(path: SignalPath, sources: ReadonlyMap<SignalPort, Carrier>): PathResult {
    const steps = [...path.steps];
    const conversions: ConversionStep[] = [];
    const supplies: SupplyBranch[] = [];
    for (const [edgeIndex, edge] of path.edges.entries()) {
      if (edge.source.kind !== 'transfer') continue;
      const kind = edge.source.transfer.kind;
      if (kind !== 'eo' && kind !== 'dml' && kind !== 'oe') continue;
      conversions.push({ kind, edgeIndex });
      if (!edge.supply) continue;

      const supply = findOpticalSupply(graph, outgoing, edge.supply, steps[edgeIndex + 1].channelIds, sources);
      const endpoint = edge.supply.ref;
      if (supply.status === 'cascaded_modulation') return { status: 'unreachable', endpoint, reason: cascadedModulation };
      if (supply.status === 'incompatible_source') {
        supplies.push({ edgeIndex, endpoint, status: 'missing', reason: incompatibleSource });
        continue;
      }
      if (supply.status !== 'resolved') {
        supplies.push({ edgeIndex, endpoint, status: supply.status === 'unreachable' ? 'missing' : supply.status,
          channelPort: supply.status === 'ambiguous' ? supply.channelPort?.ref : undefined });
        continue;
      }
      supplies.push({ edgeIndex, endpoint, status: 'resolved', path: supply.path });
      const channelIds = supply.path.steps.at(-1)?.channelIds;
      for (let i = edgeIndex + 1; i < steps.length; i++) {
        steps[i] = { ...steps[i], channelIds: intersectCarrier(steps[i].channelIds, channelIds) };
        if (path.edges[i]?.channels.kind !== 'preserve') break;
      }
    }
    const trace = { steps, edges: path.edges, conversions, supplies };
    const failure = supplies.find(supply => supply.status !== 'resolved');
    if (failure) {
      const status = failure.status === 'missing' ? 'unreachable' : failure.status;
      const reason = failure.channelPort ? chooseRouteChannel : failure.status === 'missing' ? '没有供光路径经兼容通道到达调制器的输入端口。'
        : failure.status === 'ambiguous' ? '有多条供光路径到达调制器的输入端口，请选择供光来源。'
        : failure.status === 'feedback_loop' ? '不支持供光路径中的反馈回路。'
        : '供光路径搜索超出资源上限。';
      return { status, reason: failure.reason ?? reason, endpoint: failure.channelPort ?? failure.endpoint, trace };
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
        || !supportsDirection(port.definition.direction, scope.kind === 'module' ? 'in' : 'out')) {
        return { status: 'invalid_reference', endpoint: ref, reason: '供光源必须位于器件的光输出端口或模块的光输入端口。' };
      }
      if (ref.channelId !== undefined && !resolveOpticalChannel(ref.channelId)) {
        return { status: 'invalid_reference', endpoint: ref, reason: `未知光源通道「${ref.channelId}」。` };
      }
      addSourceCarrier(sources, port, ref.channelId);
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
      if (!edge) return { status: 'unreachable', reason: '必经纤芯未接通，请检查所选纤芯两端的附件。' };
      requiredEdges.push(edge);
    }
    const carrier: Carrier = request.channelId === undefined ? undefined : [request.channelId];
    const query = {
      starts: [from], target: to, adjacent: outgoing, carrier, ...routeConstraints(requiredEdges),
      startFlow: from.definition.opticalEmitter || sources.has(from) ? opticalSourceFlow : undefined,
      startCarriers: sources,
    };
    let result = searchSignalPath(query);
    if (result.status === 'ambiguous' && result.channelPort && !request.channelId) {
      // A uniquely supplied wavelength can select a route beyond the EO boundary.
      const carriers = new Map<SignalEdge, Carrier>();
      result = searchSignalPath({ ...query, supplyCarrier: edge => {
        if (!carriers.has(edge)) {
          const supply = findOpticalSupply(graph, outgoing, edge.supply!, undefined, sources);
          carriers.set(edge, supply.status === 'resolved' ? supply.path.steps.at(-1)?.channelIds : undefined);
        }
        return carriers.get(edge);
      } });
    }
    switch (result.status) {
      case 'resolved': return traceSupplies(result.path, sources);
      case 'ambiguous': return { status: 'ambiguous', reason: result.channelPort ? chooseRouteChannel : '有多条路径满足端点与路由约束。',
        endpoint: result.channelPort?.ref };
      case 'feedback_loop': return { status: 'feedback_loop', endpoint: result.endpoint.ref, reason: '不支持所选路径中的反馈回路。' };
      case 'search_limit': return { status: 'search_limit', reason: '路径搜索超出资源上限。' };
      case 'unreachable': {
        if (!result.reached.has(to)) {
          const reverse = searchSignalPath({ starts: [to], adjacent: incoming, carrier: undefined, reverse: true });
          if (reverse.status === 'search_limit') return { status: 'search_limit', reason: '端口映射诊断超出资源上限。' };
          if (reverse.status === 'unreachable') {
            const forwardPorts = [...result.reached];
            const reversePorts = [...reverse.reached];
            const inputs = forwardPorts.filter(port => port.unmapped && supportsDirection(port.definition.direction, 'in'));
            const outputs = reversePorts.filter(port => port.unmapped && supportsDirection(port.definition.direction, 'out'));
            const open = inputs.find(port => reversePorts.some(other => inside(port.ref.instancePath, other.ref.instancePath))
                || outputs.some(other => JSON.stringify(port.ref.instancePath) === JSON.stringify(other.ref.instancePath)))
              ?? outputs.find(port => forwardPorts.some(other => inside(port.ref.instancePath, other.ref.instancePath)));
            if (open) return { status: 'incomplete', endpoint: open.ref, reason: '路径所需的模块端口缺少内部映射。' };
          }
        }
        if (digitalEdges.length && (from.definition.type === 'CONTROL' || to.definition.type === 'CONTROL')) {
          const physical = searchSignalPath({ ...query, ignoreChannels: true });
          if (physical.status === 'resolved' && physical.path.edges.some(isDigitalEdge)) return {
            status: 'unreachable', reason: '数字光路的端口、光源或传输不支持所选光通道。',
          };
        }
        const reachedDml = dmlEdges.filter(edge => result.reached.has(edge.from));
        if (reachedDml.length === 1 && from.definition.type === 'RF') {
          const dml = reachedDml[0];
          // A rejected emission stops at RF_IN. A completed detection can continue into downstream RF.
          const emitted = result.reached.has(dml.to);
          let last = emitted ? dml.to : dml.from;
          const visited = new Set([last]);
          if (emitted) {
            for (;;) {
              const next = outgoing.get(last)?.filter(edge => result.reached.has(edge.to));
              if (next?.length !== 1 || visited.has(next[0].to)) break;
              last = next[0].to;
              visited.add(last);
            }
          }
          const prefix = searchSignalPath({ starts: [from], target: last, adjacent: outgoing, carrier, startCarriers: sources });
          const trace = prefix.status === 'resolved' ? traceSupplies(prefix.path, sources).trace : undefined;
          const cascaded = graph.edges.some(edge => edge.supply && visited.has(edge.supply));
          const rejected = !emitted ? dml : outgoing.get(last)?.find(edge => !result.reached.has(edge.to));
          const channel = trace?.steps.at(-1)?.channelIds?.join(' / ') ?? request.channelId;
          const switched = graph.instances.find(item => JSON.stringify(item.instancePath) === JSON.stringify(last.ref.instancePath))?.switchState;
          const reason = cascaded ? cascadedModulation
            : rejected ? `直调路径的端口或传输不支持光通道${channel ? ' ' + channel : ''}。`
            : last.definition.type === 'RF' ? '射频路径未接通到所选目标，或未经过指定连接。'
            : switched ? `光开关在「${switched.name}」状态下未接通到目标的光路。`
            : '直调光路未接通到所选目标，或未经过指定连接。';
          return { status: 'unreachable', endpoint: rejected?.to.ref ?? last.ref, trace, reason };
        }
        return { status: 'unreachable', reason: '没有路径满足端点与路由约束。' };
      }
    }
  }

  function resolveNamedLink(link: NamedLink, options: PathOptions = {}): PathResult {
    try {
      validateNamedLinks([link], path => scopes.get(JSON.stringify(path)));
    } catch (error) {
      return { status: 'invalid_reference', reason: (error as Error).message };
    }
    const result: PathResult = link.from && link.to
      ? resolve({ from: link.from, to: link.to, channelId: link.channelId }, options, link)
      : { status: 'incomplete', reason: '尚未连接：请设置链路起点和终点。' };
    if (result.status !== 'resolved' && digitalEdges.length) {
      const tx = link.from && digitalAccess(link.from, true), rx = link.to && digitalAccess(link.to, false);
      if (tx || rx) {
        const access = [...(tx ?? []), ...(rx ?? [])];
        if ((result.status === 'unreachable' || result.status === 'incomplete') && link.from && link.to
          && getPort(link.from)?.definition.type === 'CONTROL' && getPort(link.to)?.definition.type === 'CONTROL') {
          if (tx) access.push(...partialDigitalSpan(link, tx, true, options, rx));
          if (rx) access.push(...partialDigitalSpan(link, rx, false, options, tx));
        }
        return { ...result, digitalAccess: access };
      }
    }
    return result;
  }

  function resolveLocalPath(request: LocalPathRequest, options: PathOptions = {}): PathResult {
    return resolve(request, options);
  }

  return { graph, resolveNamedLink, resolveLocalPath, reachableFrom, followBoundary, controlTerminals };
}
