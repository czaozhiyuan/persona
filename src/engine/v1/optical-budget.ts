import { findOpticalSupply } from './optical-supply';
import type { Carrier } from './path-search';
import { resolveOpticalChannel } from '../../model/v1/channels';
import type { OpticalChannelId } from '../../model/v1/channels';
import type { ConversionBoundary, OpticalSource } from '../../model/v1/topology';
import type { EndpointRef, Project } from '../../model/v1/types';
import { addGain, budgetValue, checkInputRating, unavailable } from './budget-metric';
import type { BudgetMetric, InputRatingCheck } from './budget-metric';
import { resolveEmpiricalValue } from './empirical-value';
import { searchSignalPath } from './path-search';
import type { SearchResult, SignalPath } from './path-search';
import { buildSignalGraph, signalPortKey } from './signal-graph';
import type { SignalEdge, SignalGraph, SignalPort } from './signal-graph';

export type { OpticalSource } from '../../model/v1/topology';
export function photocurrent(power: BudgetMetric<'dBm'>, rho: BudgetMetric<'A/W'>) {
  if (power.availability === 'unavailable') return unavailable('A', power.reason);
  if (rho.availability === 'unavailable') return unavailable('A', `响应度：${rho.reason}`);
  return budgetValue('A', rho.value * 10 ** ((power.value - 30) / 10));
}

export type LocalOpticalRequest =
  | { source: OpticalSource; to: EndpointRef }
  | { eo: ConversionBoundary; sources: readonly OpticalSource[]; channelId: OpticalChannelId; to: EndpointRef };

type OpticalStage = {
  endpoint: EndpointRef;
  channelId: OpticalChannelId;
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
};

/** Calculates optical power over the validated V1 graph. The input snapshot is never edited. */
export function createOpticalBudget(project: Project) {
  return createOpticalBudgetForGraph(buildSignalGraph(project));
}

export function createOpticalBudgetForGraph(graph: SignalGraph) {
  const instances = new Map(graph.instances.map(item => [JSON.stringify(item.instancePath), item]));
  const outgoing = new Map<SignalPort, SignalEdge[]>();
  for (const edge of graph.edges) {
    const edges = outgoing.get(edge.from) ?? [];
    edges.push(edge);
    outgoing.set(edge.from, edges);
  }
  const instanceAt = (ref: EndpointRef) => instances.get(JSON.stringify(ref.instancePath));
  const portAt = (ref: EndpointRef) => graph.ports.get(signalPortKey(ref));

  function search(starts: readonly SignalPort[], target: SignalPort, channelId: OpticalChannelId, targetChannel?: OpticalChannelId) {
    return searchSignalPath({ starts, target, adjacent: outgoing, carrier: [channelId],
      targetCarrier: targetChannel === undefined ? undefined : [targetChannel], opticalOnly: true });
  }

  function stage(port: SignalPort, channelId: OpticalChannelId, powerDbm: BudgetMetric<'dBm'>,
    incoming?: OpticalStage['incoming']): OpticalStage {
    const endpoint = port.ref;
    return { endpoint, channelId, powerDbm, incoming, rating: checkInputRating(endpoint, port.definition.inputRating, powerDbm) };
  }

  function finish(stages: OpticalStage[], gainDb: BudgetMetric<'dB'>, pathIssue?: PathIssue): OpticalBudget {
    const powerDbm = pathIssue ? unavailable('dBm', pathIssue.reason) : stages.at(-1)!.powerDbm;
    const status = powerDbm.availability === 'available' && gainDb.availability === 'available' ? 'valid'
      : gainDb.availability === 'available' || stages.some(item => item.powerDbm.availability === 'available'
        || item.incoming?.gainDb.availability === 'available'
        || item.incoming?.opticalLoss?.intrinsicLossDb.availability === 'available'
        || item.incoming?.opticalLoss?.quadratureLossDb.availability === 'available') ? 'partial' : 'error';
    const last = stages.at(-1);
    let averageCurrent: BudgetMetric<'A'> | undefined;
    if (last && !pathIssue) {
      const target = portAt(last.endpoint)!;
      const detectors = outgoing.get(target)?.flatMap(({ source }) => source.kind === 'transfer' && source.transfer.kind === 'oe'
        && (!source.transfer.channelIds || source.transfer.channelIds.includes(last.channelId)) ? [source.transfer] : []);
      if (detectors?.length === 1) {
        const rho = resolveEmpiricalValue('A/W', detectors[0].responsivity, { channelId: last.channelId }, instanceAt(last.endpoint));
        averageCurrent = photocurrent(powerDbm, rho);
      }
    }
    return { status, stages, powerDbm, gainDb, pathIssue, averageCurrent };
  }

  function fail(status: PathIssue['status'], endpoint: EndpointRef, reason: string, stages: OpticalStage[] = []) {
    return finish(stages, unavailable('dB', reason), { status, endpoint, reason });
  }

  function pathFailure(result: Exclude<SearchResult, { status: 'resolved' }>, target: SignalPort,
    stages: OpticalStage[] = [], supply = false) {
    const subject = supply ? '供光路径' : '光路';
    const reason = result.status === 'unreachable' ? (supply
      ? '已声明的光源无法经兼容通道到达调制器供光输入。'
      : '没有光路经兼容通道到达目标端口。')
      : result.status === 'ambiguous' ? `有多条${subject}到达目标端口。`
      : result.status === 'feedback_loop' ? `不支持${subject}中的反馈回路。`
      : `${subject}搜索超出资源上限。`;
    return fail(supply && result.status === 'unreachable' ? 'missing_supply' : result.status,
      result.status === 'feedback_loop' ? result.endpoint.ref : target.ref, reason, stages);
  }

  function advance(stages: OpticalStage[], edge: SignalEdge, gainDb: BudgetMetric<'dB'>) {
    const previous = stages.at(-1)!;
    const source = edge.source;
    const query = { channelId: previous.channelId };
    const instance = instanceAt(edge.from.ref);
    if (source.kind === 'transfer' && source.transfer.kind === 'eo') {
      const intrinsic = resolveEmpiricalValue('dB', source.transfer.insertionLossDb, query, instance);
      const quadrature = 10 * Math.log10(2);
      const opticalLoss = { intrinsicLossDb: intrinsic, quadratureLossDb: budgetValue('dB', quadrature) };
      const gain = intrinsic.availability === 'unavailable'
        ? unavailable('dB', `${edge.from.ref.instancePath.join('/')} 最大透过插损：${intrinsic.reason}`)
        : budgetValue('dB', -intrinsic.value - quadrature);
      stages.push(stage(edge.to, previous.channelId, addGain(previous.powerDbm, gain), { edge, gainDb: gain, opticalLoss }));
      return addGain(gainDb, gain);
    }
    const declared = source.kind === 'switchRoute' ? source.route.gainDb
      : source.kind === 'transfer' && 'gainDb' in source.transfer ? source.transfer.gainDb : undefined;
    // Every device route needs an explicit gain, even if its specified gain is zero.
    const gain = source.kind === 'switchRoute' || source.kind === 'transfer'
      ? resolveEmpiricalValue('dB', declared, query, instance)
      : budgetValue('dB', 0);
    const nextChannel = edge.channels.kind === 'convert' ? edge.channels.toChannelId : previous.channelId;
    stages.push(stage(edge.to, nextChannel, addGain(previous.powerDbm, gain), { edge, gainDb: gain }));
    return addGain(gainDb, gain);
  }

  function propagate(stages: OpticalStage[], edges: readonly SignalEdge[], gain: BudgetMetric<'dB'>) {
    for (const edge of edges) gain = advance(stages, edge, gain);
    return gain;
  }

  function sourceIssue(source: OpticalSource, port: SignalPort | undefined): string | undefined {
    if (!resolveOpticalChannel(source.channelId)) return `未知光通道「${source.channelId}」。`;
    const kind = instanceAt(source.endpoint)?.definition.kind;
    if (port?.definition.type !== 'OPTICAL'
      || port.definition.direction !== (kind === 'module' ? 'in' : 'out')) {
      return '光源必须位于器件的光输出端口或模块的光输入端口。';
    }
  }

  function start(port: SignalPort, source: OpticalSource) {
    const power = source.powerDbm === undefined
      ? resolveEmpiricalValue('dBm', port.definition.opticalEmitter?.powerDbm, { channelId: source.channelId }, instanceAt(port.ref))
      : budgetValue('dBm', source.powerDbm);
    return [stage(port, source.channelId, power.availability === 'available' ? power
      : unavailable('dBm', `${port.ref.instancePath.join('/')} · ${port.ref.portId} 光源功率：${power.reason}`))];
  }

  function calculateOpticalPath(path: SignalPath, source: OpticalSource) {
    const stages = start(path.steps[0].port, source);
    return finish(stages, propagate(stages, path.edges, budgetValue('dB', 0)));
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
      const path = search([port], target, source.channelId);
      if (path.status !== 'resolved') return pathFailure(path, target);
      return calculateOpticalPath(path.path, source);
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
    if (!resolveOpticalChannel(channelId) || (edge.channels.kind === 'enter' && edge.channels.channelIds
      && !edge.channels.channelIds.includes(channelId))) {
      return fail('missing_supply', supply.ref, `该电光转换不支持光通道「${channelId}」。`);
    }

    const selected = new Map<SignalPort, Carrier>();
    for (const source of sources) {
      const port = portAt(source.endpoint);
      const problem = sourceIssue(source, port);
      if (!port || problem) return fail('invalid_reference', source.endpoint, problem ?? '光源端口不存在。');
      selected.set(port, [...(selected.get(port) ?? []), source.channelId]);
    }
    const candidate = findOpticalSupply(graph, outgoing, supply, [channelId], selected);
    if (candidate.status !== 'resolved') return pathFailure(candidate, supply, [], true);
    const first = candidate.path.steps[0];
    if (first.channelIds?.length !== 1) return fail('ambiguous', first.port.ref, '请选择光源通道。');
    const matching = sources.filter(source => signalPortKey(source.endpoint) === signalPortKey(first.port.ref)
      && source.channelId === first.channelIds![0]);
    if (matching.length > 1) return fail('ambiguous', first.port.ref, '供光功率不唯一。');
    const supplied = { path: candidate.path, source: matching[0] ?? { endpoint: first.port.ref, channelId: first.channelIds[0] } };
    const path = search([edge.to], target, channelId);
    if (path.status !== 'resolved') {
      return pathFailure(path, target, calculateEoSupply(supplied.path, supplied.source, edge).stages);
    }
    return calculateEoPath(supplied.path, supplied.source, edge, path.path.edges);
  }

  return { calculateLocal, calculateEoPath, calculateOpticalPath };
}
