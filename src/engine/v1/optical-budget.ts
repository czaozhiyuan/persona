import { resolveOpticalChannel } from '../../model/v1/channels';
import type { OpticalChannelId } from '../../model/v1/channels';
import type { ConversionBoundary } from '../../model/v1/topology';
import type { EndpointRef, Project } from '../../model/v1/types';
import { addGain, budgetValue, checkInputRating, unavailable } from './budget-metric';
import type { BudgetMetric, InputRatingCheck } from './budget-metric';
import { resolveEmpiricalValue } from './empirical-value';
import { searchSignalPath } from './path-search';
import type { SearchResult, SignalPath } from './path-search';
import { buildSignalGraph, signalPortKey } from './signal-graph';
import type { SignalEdge, SignalGraph, SignalPort } from './signal-graph';

export type OpticalSource = { endpoint: EndpointRef; channelId: OpticalChannelId; powerDbm?: number };
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
    opticalLoss?: { intrinsicLossDb: BudgetMetric<'dB'>; operatingPointLossDb: BudgetMetric<'dB'> };
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
        || item.incoming?.opticalLoss?.operatingPointLossDb.availability === 'available') ? 'partial' : 'error';
    return { status, stages, powerDbm, gainDb, pathIssue };
  }

  function fail(status: PathIssue['status'], endpoint: EndpointRef, reason: string, stages: OpticalStage[] = []) {
    return finish(stages, unavailable('dB', reason), { status, endpoint, reason });
  }

  function pathFailure(result: Exclude<SearchResult, { status: 'resolved' }>, target: SignalPort,
    stages: OpticalStage[] = [], supply = false) {
    const subject = supply ? 'optical supply' : 'optical path';
    const reason = result.status === 'unreachable' ? (supply
      ? 'No declared optical supply reaches the EO input on a compatible channel.'
      : 'No optical path reaches the target on a compatible channel.')
      : result.status === 'ambiguous' ? `More than one ${subject} route reaches the target.`
      : result.status === 'feedback_loop' ? `Feedback on the ${subject} is unsupported.`
      : `The ${subject} search exceeded its resource limit.`;
    return fail(supply && result.status === 'unreachable' ? 'missing_supply' : result.status,
      result.status === 'feedback_loop' ? result.endpoint.ref : target.ref, reason, stages);
  }

  function advance(stages: OpticalStage[], edge: SignalEdge, gainDb: BudgetMetric<'dB'>) {
    const previous = stages.at(-1)!;
    const source = edge.source;
    const query = { channelId: previous.channelId };
    const instance = instanceAt(edge.from.ref);
    if (source.kind === 'transfer' && source.transfer.kind === 'eo' && source.transfer.opticalLoss !== undefined) {
      const { intrinsicLossDb, operatingPointLossDb } = source.transfer.opticalLoss;
      const opticalLoss = {
        intrinsicLossDb: resolveEmpiricalValue('dB', intrinsicLossDb, query, instance),
        operatingPointLossDb: resolveEmpiricalValue('dB', operatingPointLossDb, query, instance),
      };
      const intrinsic = opticalLoss.intrinsicLossDb;
      const operating = opticalLoss.operatingPointLossDb;
      const gain = intrinsic.availability === 'unavailable' ? unavailable('dB', `Intrinsic loss: ${intrinsic.reason}`)
        : operating.availability === 'unavailable' ? unavailable('dB', `Operating-point loss: ${operating.reason}`)
        : budgetValue('dB', 0 - (intrinsic.value + operating.value));
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
    if (!resolveOpticalChannel(source.channelId)) return `Unknown optical channel "${source.channelId}".`;
    const kind = instanceAt(source.endpoint)?.definition.kind;
    if (port?.definition.type !== 'OPTICAL'
      || port.definition.direction !== (kind === 'module' ? 'in' : 'out')) {
      return 'An optical source must be a component output or module input.';
    }
  }

  function start(port: SignalPort, source: OpticalSource) {
    return [stage(port, source.channelId, source.powerDbm === undefined
      ? unavailable('dBm', 'The optical source power is not provided.') : budgetValue('dBm', source.powerDbm))];
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
    if (target?.definition.type !== 'OPTICAL') return fail('invalid_reference', request.to, 'An optical target port is required.');
    if ('source' in request) {
      const { source } = request;
      const port = portAt(source.endpoint);
      const problem = sourceIssue(source, port);
      if (!port || problem) return fail('invalid_reference', source.endpoint, problem ?? 'The optical source port does not exist.');
      const path = search([port], target, source.channelId);
      if (path.status !== 'resolved') return pathFailure(path, target);
      const stages = start(port, source);
      return finish(stages, propagate(stages, path.path.edges, budgetValue('dB', 0)));
    }

    const { eo, sources, channelId } = request;
    const input = { instancePath: eo.instancePath, portId: eo.fromPortId };
    const output = { instancePath: eo.instancePath, portId: eo.toPortId };
    const rfInput = portAt(input);
    const matches = rfInput && outgoing.get(rfInput)?.filter(item => item.source.kind === 'transfer'
      && item.source.transfer.kind === 'eo' && item.to.ref.portId === eo.toPortId);
    if (matches && matches.length > 1) return fail('ambiguous', output, 'More than one EO transfer uses the requested boundary.');
    const edge = matches?.[0];
    if (!edge) return fail('invalid_reference', output, 'The requested EO transfer does not exist.');
    const supply = edge.supply;
    if (!supply) return fail('missing_supply', output, 'The EO transfer has no declared optical supply port.');
    if (!resolveOpticalChannel(channelId) || (edge.channels.kind === 'enter' && edge.channels.channelIds
      && !edge.channels.channelIds.includes(channelId))) {
      return fail('missing_supply', supply.ref, `The EO transfer does not support optical channel "${channelId}".`);
    }

    const groups = new Map<OpticalChannelId, { ports: SignalPort[]; sources: OpticalSource[] }>();
    for (const source of sources) {
      const port = portAt(source.endpoint);
      const problem = sourceIssue(source, port);
      if (!port || problem) return fail('invalid_reference', source.endpoint, problem ?? 'The optical source port does not exist.');
      const group = groups.get(source.channelId) ?? { ports: [], sources: [] };
      group.ports.push(port);
      group.sources.push(source);
      groups.set(source.channelId, group);
    }

    let supplied: { path: SignalPath; source: OpticalSource } | undefined;
    for (const [inputChannel, group] of groups) {
      const candidate = search(group.ports, supply, inputChannel, channelId);
      if (candidate.status === 'unreachable') continue;
      if (candidate.status !== 'resolved') return pathFailure(candidate, supply, [], true);
      const ref = candidate.path.steps[0].port.ref;
      const matching = group.sources.filter(source => signalPortKey(source.endpoint) === signalPortKey(ref));
      if (supplied || matching.length !== 1) return pathFailure({ status: 'ambiguous' }, supply, [], true);
      supplied = { path: candidate.path, source: matching[0] };
    }
    if (!supplied) {
      return fail('missing_supply', supply.ref, 'No declared optical supply reaches the EO input on a compatible channel.');
    }

    const path = search([edge.to], target, channelId);
    if (path.status !== 'resolved') {
      return pathFailure(path, target, calculateEoSupply(supplied.path, supplied.source, edge).stages);
    }
    return calculateEoPath(supplied.path, supplied.source, edge, path.path.edges);
  }

  return { calculateLocal, calculateEoPath };
}
