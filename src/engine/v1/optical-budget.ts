import { createPathNames } from './path-names';
import { portDisplayName } from '../../model/v1/display-names';
import { addSourceCarrier, cascadedModulation, findOpticalSupply, incompatibleSource, selectOpticalSource } from './optical-supply';
import type { Carrier } from './path-search';
import { resolveOpticalChannel } from '../../model/v1/channels';
import type { OpticalChannelId } from '../../model/v1/channels';
import type { ConversionBoundary, OpticalSource } from '../../model/v1/topology';
import type { EndpointRef, PortFlow, Project } from '../../model/v1/types';
import { supportsDirection } from '../../model/v1/types';
import { addGain, budgetValue, checkInputRating, logZero, unavailable } from './budget-metric';
import type { BudgetMetric, InputRatingCheck } from './budget-metric';
import { resolveEmpiricalValue } from './empirical-value';
import { cochannelConflict, createOpticalOrigins } from './optical-origins';
import { chooseRouteChannel, intersectCarrier, searchSignalPath } from './path-search';
import type { SearchResult, SignalPath } from './path-search';
import { buildSignalGraph, channelRoutingPorts, opticalSourceFlow, portFlowAt, signalPortKey } from './signal-graph';
import type { SignalEdge, SignalGraph, SignalPort } from './signal-graph';

export type { OpticalSource } from '../../model/v1/topology';
export function photocurrent(power: BudgetMetric<'dBm'>, rho: BudgetMetric<'A/W'>) {
  if (power.availability === 'unavailable') return unavailable('A', power.reason);
  if (rho.availability === 'unavailable') return unavailable('A', `响应度：${rho.reason}`);
  return budgetValue('A', rho.value * 10 ** ((power.value - 30) / 10));
}

export type LocalOpticalRequest =
  | { source: OpticalSource; to: EndpointRef }
  | { eo: ConversionBoundary; sources: readonly OpticalSource[]; channelId?: OpticalChannelId; to: EndpointRef };

type OpticalStage = {
  endpoint: EndpointRef;
  flow: PortFlow;
  channelId?: OpticalChannelId;
  powerDbm: BudgetMetric<'dBm'>;
  incoming?: {
    edge: SignalEdge;
    gainDb: BudgetMetric<'dB'>;
    opticalLoss?: { intrinsicLossDb: BudgetMetric<'dB'>; quadratureLossDb: BudgetMetric<'dB'> };
  };
  rating?: InputRatingCheck;
};

type PathIssue = {
  status: Exclude<SearchResult['status'], 'resolved'> | 'invalid_reference' | 'missing_supply';
  endpoint: EndpointRef;
  reason: string;
};

export type OpticalBudget = {
  status: 'valid' | 'partial' | 'error';
  stages: readonly OpticalStage[];
  powerDbm: BudgetMetric<'dBm'>;
  gainDb: BudgetMetric<'dB'>;
  pathIssue?: PathIssue;
  averageCurrent?: BudgetMetric<'A'>;
  digitalReceiver?: { sensitivity: BudgetMetric<'dBm'>; margin: BudgetMetric<'dB'>; overload: BudgetMetric<'dBm'>;
    aboveLimit?: boolean };
};

/** Calculates optical power over the validated V1 graph. The input snapshot is never edited. */
export function createOpticalBudget(project: Project) {
  return createOpticalBudgetForGraph(buildSignalGraph(project));
}

export function createOpticalBudgetForGraph(graph: SignalGraph, origins?: ReturnType<typeof createOpticalOrigins>) {
  const { showPath } = createPathNames(graph.instances);
  const wavelengthPorts = channelRoutingPorts(graph.edges);
  const commonPorts = new Map(graph.instances.flatMap(({ instancePath, definition }) => {
    if (definition.kind !== 'component' || !definition.wdm) return [];
    const key = signalPortKey({ instancePath, portId: 'COM' });
    return [[key, graph.ports.get(key)!] as const];
  }));
  const instances = new Map(graph.instances.map(item => [JSON.stringify(item.instancePath), item]));
  const outgoing = new Map<SignalPort, SignalEdge[]>();
  for (const edge of graph.edges) {
    const edges = outgoing.get(edge.from) ?? [];
    edges.push(edge);
    outgoing.set(edge.from, edges);
  }
  const instanceAt = (ref: EndpointRef) => instances.get(JSON.stringify(ref.instancePath));
  const portAt = (ref: EndpointRef) => graph.ports.get(signalPortKey(ref));

  function search(start: SignalPort, target: SignalPort, carrier: Carrier) {
    return searchSignalPath({ starts: [start], startFlow: opticalSourceFlow, target, adjacent: outgoing, carrier, opticalOnly: true });
  }

  function stage(port: SignalPort, channelId: OpticalChannelId | undefined, powerDbm: BudgetMetric<'dBm'>,
    incoming?: OpticalStage['incoming'], initialFlow = opticalSourceFlow(port)): OpticalStage {
    const endpoint = port.ref;
    const flow = port.definition.direction !== 'bidirectional' ? port.definition.direction
      : incoming ? portFlowAt(incoming.edge, port) : initialFlow;
    return { endpoint, flow, channelId, powerDbm, incoming,
      rating: flow === 'in' ? checkInputRating(endpoint, port.definition.inputRating, powerDbm) : undefined };
  }

  function finish(stages: OpticalStage[], gainDb: BudgetMetric<'dB'>, pathIssue?: PathIssue, receiverEdge?: SignalEdge): OpticalBudget {
    const clash = stages.find(s => s.incoming?.gainDb.availability === 'unavailable' && s.incoming.gainDb.reason === cochannelConflict);
    if (!pathIssue && clash) pathIssue = { status: 'ambiguous', endpoint: clash.endpoint, reason: cochannelConflict };
    const powerDbm = pathIssue ? unavailable('dBm', pathIssue.reason) : stages.at(-1)!.powerDbm;
    const status = powerDbm.availability === 'available' && gainDb.availability === 'available' ? 'valid'
      : gainDb.availability === 'available' || stages.some(item => item.powerDbm.availability === 'available'
        || item.incoming?.gainDb.availability === 'available'
        || item.incoming?.opticalLoss?.intrinsicLossDb.availability === 'available'
        || item.incoming?.opticalLoss?.quadratureLossDb.availability === 'available') ? 'partial' : 'error';
    const last = stages.at(-1);
    let averageCurrent: BudgetMetric<'A'> | undefined;
    let digitalReceiver: OpticalBudget['digitalReceiver'];
    if (last?.flow === 'in' && !pathIssue) {
      const target = portAt(last.endpoint)!;
      const receivers = (receiverEdge ? [receiverEdge] : outgoing.get(target) ?? []).flatMap(({ source }) =>
        source.kind === 'transfer' && source.transfer.kind === 'digitalRx'
        && (!last.channelId || !source.transfer.channelIds || source.transfer.channelIds.includes(last.channelId)) ? [source.transfer] : []);
      if (receivers.length === 1) {
        const rx = receivers[0];
        const instance = instanceAt(last.endpoint);
        const query = { channelId: last.channelId };
        const sensitivity = resolveEmpiricalValue('dBm', rx.sensitivityDbm, query, instance);
        const overload = resolveEmpiricalValue('dBm', rx.overloadDbm, query, instance);
        const margin = sensitivity.availability === 'unavailable' ? unavailable('dB', '接收灵敏度：' + sensitivity.reason)
          : powerDbm.availability === 'unavailable' ? unavailable('dB', powerDbm.reason)
          : powerDbm.value === -Infinity ? logZero('dB') : budgetValue('dB', powerDbm.value - sensitivity.value);
        digitalReceiver = { sensitivity, overload, margin,
          aboveLimit: powerDbm.availability === 'available' && overload.availability === 'available' ? powerDbm.value > overload.value : undefined };
      }
      const detectors = outgoing.get(target)?.flatMap(({ source }) => source.kind === 'transfer' && source.transfer.kind === 'oe'
        && (!last.channelId || !source.transfer.channelIds || source.transfer.channelIds.includes(last.channelId)) ? [source.transfer] : []);
      if (detectors?.length === 1) {
        const rho = resolveEmpiricalValue('A/W', detectors[0].responsivity, { channelId: last.channelId }, instanceAt(last.endpoint));
        averageCurrent = photocurrent(powerDbm, rho);
      }
    }
    return { status: digitalReceiver?.margin.availability === 'unavailable' && status === 'valid' ? 'partial' : status,
      stages, powerDbm, gainDb, pathIssue, averageCurrent, digitalReceiver };
  }

  function fail(status: PathIssue['status'], endpoint: EndpointRef, reason: string, stages: OpticalStage[] = []) {
    return finish(stages, unavailable('dB', reason), { status, endpoint, reason });
  }

  function pathFailure(result: Exclude<SearchResult, { status: 'resolved' }>, target: SignalPort,
    stages: OpticalStage[] = [], supply = false) {
    if (result.status === 'ambiguous' && result.channelPort) return fail('ambiguous', result.channelPort.ref, chooseRouteChannel, stages);
    const subject = supply ? '供光路径' : '光路';
    const reason = result.status === 'unreachable' ? (supply
      ? '已声明的光源无法经兼容通道到达调制器供光输入。'
      : '没有光路经兼容通道到达目标端口。')
      : result.status === 'ambiguous' ? (supply ? '有多条供光路径到达目标端口，请选择供光来源。' : '有多条光路到达目标端口。')
      : result.status === 'feedback_loop' ? `不支持${subject}中的反馈回路。`
      : `${subject}搜索超出资源上限。`;
    return fail(supply && result.status === 'unreachable' ? 'missing_supply' : result.status,
      result.status === 'feedback_loop' ? result.endpoint.ref : target.ref, reason, stages);
  }

  function advance(stages: OpticalStage[], edge: SignalEdge, gainDb: BudgetMetric<'dB'>) {
    const previous = stages.at(-1)!;
    const common = commonPorts.size ? commonPorts.get(signalPortKey(edge.to.ref)) : undefined;
    if (previous.channelId && common) {
      origins ??= createOpticalOrigins(graph);
      const carriers = origins(common, previous.channelId, portFlowAt(edge, edge.to));
      if (carriers.unresolved.length || carriers.paths.length > 1) {
        const gain = unavailable('dB', cochannelConflict);
        stages.push(stage(edge.to, previous.channelId, unavailable('dBm', cochannelConflict), { edge, gainDb: gain }));
        return gain;
      }
    }
    const source = edge.source;
    const query = { channelId: previous.channelId };
    const instance = instanceAt(edge.from.ref);
    if (source.kind === 'transfer' && source.transfer.kind === 'eo') {
      const intrinsic = resolveEmpiricalValue('dB', source.transfer.insertionLossDb, query, instance);
      const quadrature = 10 * Math.log10(2);
      const opticalLoss = { intrinsicLossDb: intrinsic, quadratureLossDb: budgetValue('dB', quadrature) };
      const gain = intrinsic.availability === 'unavailable'
        ? unavailable('dB', `${showPath(edge.from.ref.instancePath)} 最大透过插损：${intrinsic.reason}`)
        : budgetValue('dB', -intrinsic.value - quadrature);
      stages.push(stage(edge.to, previous.channelId, addGain(previous.powerDbm, gain), { edge, gainDb: gain, opticalLoss }));
      return addGain(gainDb, gain);
    }
    if (source.kind === 'transfer' && source.transfer.kind === 'splitter') {
      const split = source.transfer;
      const percent = resolveEmpiricalValue('%', split.firstPercent, {}, instance);
      const loss = split.excessLossDb ? resolveEmpiricalValue('dB', split.excessLossDb, {}, instance) : budgetValue('dB', 0);
      let gain: BudgetMetric<'dB'>;
      if (percent.availability === 'unavailable') gain = unavailable('dB', percent.reason);
      else {
        const outputPercent = edge.to.ref.portId === split.toPortId ? percent.value : 100 - percent.value;
        if (outputPercent === 0) {
          const zeroGain = logZero('dB');
          stages.push(stage(edge.to, previous.channelId, logZero('dBm'), { edge, gainDb: zeroGain }));
          return zeroGain;
        }
        gain = loss.availability === 'unavailable' ? loss : budgetValue('dB', 10 * (Math.log10(outputPercent) - 2) - loss.value);
      }
      stages.push(stage(edge.to, previous.channelId, addGain(previous.powerDbm, gain), { edge, gainDb: gain }));
      return addGain(gainDb, gain);
    }
    const loss = source.kind === 'transfer' && source.transfer.kind === 'optical' ? source.transfer.insertionLossDb : undefined;
    const declared = source.kind === 'switchRoute' ? source.route.gainDb
      : source.kind === 'transfer' && 'gainDb' in source.transfer ? source.transfer.gainDb : undefined;
    // Every device route needs an explicit gain, even if its specified gain is zero.
    const value = source.kind === 'switchRoute' || source.kind === 'transfer'
      ? !previous.channelId && (wavelengthPorts.from.has(edge.from) || wavelengthPorts.to.has(edge.to))
        ? unavailable('dB', '该器件按波长选路，请选择光通道。') : resolveEmpiricalValue('dB', loss ?? declared, query, instance)
      : budgetValue('dB', (source.kind === 'connection' || source.kind === 'cableCore') && source.lossDb ? -source.lossDb : 0);
    const gain = value.availability === 'unavailable'
      ? unavailable('dB', `${showPath(edge.from.ref.instancePath)} ${loss ? '光插损' : '光增益'}：${value.reason}`)
      : loss ? budgetValue('dB', 0 - value.value) : value;
    const nextChannel = edge.channels.kind === 'convert' ? edge.channels.toChannelId : previous.channelId;
    stages.push(stage(edge.to, nextChannel, addGain(previous.powerDbm, gain), { edge, gainDb: gain }));
    return addGain(gainDb, gain);
  }

  function propagate(stages: OpticalStage[], edges: readonly SignalEdge[], gain: BudgetMetric<'dB'>) {
    for (const edge of edges) gain = advance(stages, edge, gain);
    return gain;
  }

  function sourceIssue(source: OpticalSource, port: SignalPort | undefined): string | undefined {
    if (source.channelId !== undefined && !resolveOpticalChannel(source.channelId)) return `未知光通道「${source.channelId}」。`;
    const kind = instanceAt(source.endpoint)?.definition.kind;
    if (port?.definition.type !== 'OPTICAL'
      || !supportsDirection(port.definition.direction, kind === 'module' ? 'in' : 'out')) {
      return '光源必须位于器件的光输出端口或模块的光输入端口。';
    }
  }

  function start(port: SignalPort, source: OpticalSource, flow?: PortFlow) {
    const power = source.powerDbm === undefined
      ? resolveEmpiricalValue('dBm', port.definition.opticalEmitter?.powerDbm, { channelId: source.channelId }, instanceAt(port.ref))
      : budgetValue('dBm', source.powerDbm);
    return [stage(port, source.channelId, power.availability === 'available' ? power
      : unavailable('dBm', `${showPath(port.ref.instancePath)} · ${portDisplayName(port.definition)} 光源功率：${power.reason}`), undefined, flow)];
  }

  function calculateOpticalPath(path: SignalPath, source: OpticalSource, receiverEdge?: SignalEdge) {
    const first = path.steps[0].port;
    const departure = path.edges.length ? portFlowAt(path.edges[0], first) : opticalSourceFlow(first);
    const hasSource = first.definition.opticalEmitter !== undefined || source.powerDbm !== undefined;
    if (hasSource && first.definition.direction === 'bidirectional' && departure !== opticalSourceFlow(first)) {
      return fail('unreachable', first.ref, '该路径不经过此双向光口的供光方向。');
    }
    const stages = start(first, source, departure);
    return finish(stages, propagate(stages, path.edges, budgetValue('dB', 0)), undefined, receiverEdge);
  }

  function calculateSourcePath(path: SignalPath, selection: OpticalSource | readonly OpticalSource[] = [], receiverEdge?: SignalEdge) {
    const first = path.steps[0];
    const source = 'endpoint' in selection ? selection : selectOpticalSource(first, selection);
    if (!source) return fail('ambiguous', first.port.ref, '该光源有多项供光设置，请选择唯一的光通道。');
    const problem = sourceIssue(source, path.steps[0].port);
    return problem ? fail('invalid_reference', source.endpoint, problem) : calculateOpticalPath(path, source, receiverEdge);
  }

  function calculateEoSupply(supply: SignalPath, source: OpticalSource, eo: SignalEdge) {
    const stages = start(supply.steps[0].port, source);
    const gain = propagate(stages, supply.edges, budgetValue('dB', 0));
    return { stages, gainDb: advance(stages, eo, gain) };
  }

  /** Evaluates the supplied EO and the already selected optical edges up to the PD input. */
  function calculateEoPath(supply: SignalPath, source: OpticalSource, eo: SignalEdge, opticalEdges: readonly SignalEdge[]) {
    const { stages, gainDb } = calculateEoSupply(supply, source, eo);
    return finish(stages, propagate(stages, opticalEdges, gainDb));
  }

  function calculateLocal(request: LocalOpticalRequest): OpticalBudget {
    const target = portAt(request.to);
    if (target?.definition.type !== 'OPTICAL') return fail('invalid_reference', request.to, '需要指定目标光端口。');
    if ('source' in request) {
      const { source } = request;
      const port = portAt(source.endpoint);
      const problem = sourceIssue(source, port);
      if (!port || problem) return fail('invalid_reference', source.endpoint, problem ?? '光源端口不存在。');
      const path = search(port, target, source.channelId ? [source.channelId] : undefined);
      if (path.status !== 'resolved') return pathFailure(path, target,
        !source.channelId || !port.definition.channelIds || port.definition.channelIds.includes(source.channelId) ? start(port, source) : []);
      return calculateOpticalPath(path.path, selectOpticalSource(path.path.steps[0], [source])!);
    }

    const { eo, sources, channelId } = request;
    const input = { instancePath: eo.instancePath, portId: eo.fromPortId };
    const output = { instancePath: eo.instancePath, portId: eo.toPortId };
    const rfInput = portAt(input);
    const matches = rfInput && outgoing.get(rfInput)?.filter(item => item.source.kind === 'transfer'
      && item.source.transfer.kind === 'eo' && item.to.ref.portId === eo.toPortId);
    if (matches && matches.length > 1) return fail('ambiguous', output, '所选边界对应多项电光转换。');
    const edge = matches?.[0];
    if (!edge) return fail('invalid_reference', output, '所选电光转换不存在。');
    const supply = edge.supply;
    if (!supply) return fail('missing_supply', output, '该电光转换未声明供光端口。');
    const allowed = edge.channels.kind === 'enter' ? edge.channels.channelIds : undefined;
    if (channelId !== undefined && (!resolveOpticalChannel(channelId) || (allowed && !allowed.includes(channelId)))) {
      return fail('missing_supply', supply.ref, `该电光转换不支持光通道「${channelId}」。`);
    }

    const selected = new Map<SignalPort, Carrier>();
    for (const source of sources) {
      const port = portAt(source.endpoint);
      const problem = sourceIssue(source, port);
      if (!port || problem) return fail('invalid_reference', source.endpoint, problem ?? '光源端口不存在。');
      addSourceCarrier(selected, port, source.channelId);
    }
    const carrier = channelId ? [channelId] : allowed;
    let path = search(edge.to, target, carrier);
    const getSupply = (outputCarrier: Carrier) => findOpticalSupply(graph, outgoing, supply, outputCarrier, selected);
    let candidate = getSupply(path.status === 'resolved' ? path.path.steps[0].channelIds : carrier);
    if (path.status === 'ambiguous' && candidate.status === 'resolved') {
      path = search(edge.to, target, intersectCarrier(carrier, candidate.path.steps.at(-1)?.channelIds));
      if (path.status === 'resolved') candidate = getSupply(path.path.steps[0].channelIds);
    }
    if (candidate.status === 'cascaded_modulation') return fail('unreachable', supply.ref, cascadedModulation);
    if (candidate.status === 'incompatible_source') return fail('missing_supply', supply.ref, incompatibleSource);
    if (candidate.status !== 'resolved') return pathFailure(candidate, supply, [], true);
    const first = candidate.path.steps[0];
    const source = selectOpticalSource(first, sources);
    if (!source) return fail('ambiguous', first.port.ref, '该光源有多项供光设置，请选择唯一的光通道。');
    if (path.status !== 'resolved') {
      return pathFailure(path, target, calculateEoSupply(candidate.path, source, edge).stages);
    }
    return calculateEoPath(candidate.path, source, edge, path.path.edges);
  }

  function calculateDigitalPath(path: SignalPath, channel?: OpticalChannelId, sources: readonly OpticalSource[] = []) {
    const first = path.steps.findIndex(step => step.port.definition.type === 'OPTICAL');
    if (first < 0) return;
    let last = first;
    while (last + 1 < path.steps.length && path.steps[last + 1].port.definition.type === 'OPTICAL') last++;
    if (path.steps.slice(last + 1).some(step => step.port.definition.type !== 'CONTROL')
      || path.steps.slice(0, first).some(step => step.port.definition.type !== 'CONTROL')) return;
    const start = path.steps[first];
    const steps = path.steps.slice(first, last + 1);
    if (channel && start.channelIds?.length !== 1) steps[0] = { ...start, channelIds: intersectCarrier(start.channelIds, [channel]) };
    return calculateSourcePath({ steps, edges: path.edges.slice(first, last) }, sources, path.edges[last]);
  }

  return { calculateLocal, calculateEoPath, calculateOpticalPath, calculateSourcePath, calculateDigitalPath };
}
