import type { Transfer } from '../../model/v1/device';
import type { NamedLink } from '../../model/v1/topology';
import type { EndpointRef, Project } from '../../model/v1/types';
import { addGain, budgetValue, checkInputRating, unavailable } from './budget-metric';
import type { BudgetMetric, InputRatingCheck } from './budget-metric';
import { resolveEmpiricalValue } from './empirical-value';
import type { ResolvedInstance } from './hierarchy';
import { createPathResolver } from './path-resolver';
import type { LocalPathRequest, PathResult } from './path-resolver';
import type { SignalEdge, SignalGraph, SignalPort } from './signal-graph';

export type RfBudgetInput = { frequencyGHz: number; inputPowerDbm?: number };

export function isRfFrequency(frequencyGHz: number): boolean {
  return Number.isFinite(frequencyGHz) && frequencyGHz >= 0 && frequencyGHz <= 67;
}

type RfStageValues = { gainDb: BudgetMetric<'dB'>; nfDb: BudgetMetric<'dB'> };
type RfStage = {
  endpoint: EndpointRef;
  powerDbm: BudgetMetric<'dBm'>;
  cumulativeGainDb: BudgetMetric<'dB'>;
  cumulativeNfDb: BudgetMetric<'dB'>;
  incoming?: { edge: SignalEdge; device?: RfStageValues };
  rating?: InputRatingCheck;
};

type RfPathIssue = {
  status: Exclude<PathResult['status'], 'resolved'> | 'invalid_frequency' | 'not_pure_rf';
  endpoint?: EndpointRef;
  reason: string;
};

export type RfBudget = RfStageValues & {
  status: 'valid' | 'partial' | 'error';
  frequencyGHz: number;
  powerDbm: BudgetMetric<'dBm'>;
  stages: readonly RfStage[];
  pathIssue?: RfPathIssue;
};

/** Evaluates a single RF device transfer for either a pure RF or a mixed-domain budget. */
export function resolveRfStage(transfer: Extract<Transfer, { kind: 'rf' }>, instance: ResolvedInstance | undefined,
  frequencyGHz: number): RfStageValues {
  const query = { frequencyGHz };
  return {
    gainDb: resolveEmpiricalValue('dB', transfer.gainDb, query, instance),
    nfDb: resolveEmpiricalValue('dB', transfer.nfDb, query, instance),
  };
}

function appendNoise(previous: BudgetMetric<'ratio'> | undefined, nf: BudgetMetric<'dB'>,
  precedingGain: BudgetMetric<'dB'>): BudgetMetric<'ratio'> {
  if (previous?.availability === 'unavailable') return previous;
  if (nf.availability === 'unavailable') return unavailable('ratio', nf.reason);
  const factor = 10 ** (nf.value / 10);
  if (factor <= 0 || !Number.isFinite(factor)) return unavailable('ratio', '射频线性噪声因子超出数值范围。');
  if (!previous) return budgetValue('ratio', factor);
  if (nf.value === 0) return previous;
  if (precedingGain.availability === 'unavailable') return unavailable('ratio', `前级射频增益：${precedingGain.reason}`);
  const linearGain = 10 ** (precedingGain.value / 10);
  if (linearGain <= 0 || !Number.isFinite(linearGain)) return unavailable('ratio', '射频线性增益超出数值范围。');
  return budgetValue('ratio', previous.value + (factor - 1) / linearGain);
}

function noiseFigure(factor?: BudgetMetric<'ratio'>): BudgetMetric<'dB'> {
  if (!factor) return budgetValue('dB', 0);
  return factor.availability === 'available' ? budgetValue('dB', 10 * Math.log10(factor.value))
    : unavailable('dB', factor.reason);
}

function failed(frequencyGHz: number, pathIssue: RfPathIssue): RfBudget {
  return { status: 'error', frequencyGHz, stages: [], pathIssue, gainDb: unavailable('dB', pathIssue.reason),
    nfDb: unavailable('dB', pathIssue.reason), powerDbm: unavailable('dBm', pathIssue.reason) };
}

/** Evaluates the selected path using effective parameters from the same graph. */
export function createRfPathBudget(graph: SignalGraph) {
  const instances = new Map(graph.instances.map(item => [JSON.stringify(item.instancePath), item]));

  return function calculate(path: PathResult, input: RfBudgetInput): RfBudget {
    const { frequencyGHz, inputPowerDbm } = input;
    if (!isRfFrequency(frequencyGHz)) {
      return failed(frequencyGHz, { status: 'invalid_frequency', reason: '射频频率须在 0 至 67 GHz 范围内。' });
    }
    if (path.status !== 'resolved') return failed(frequencyGHz, { status: path.status, reason: path.reason, endpoint: path.endpoint });
    const nonRf = path.trace.steps.find(step => step.port.definition.type !== 'RF');
    if (nonRf) {
      return failed(frequencyGHz, { status: 'not_pure_rf', endpoint: nonRf.port.ref, reason: '纯射频预算要求整条路径均为射频。' });
    }

    let powerDbm = inputPowerDbm === undefined ? unavailable('dBm', '未提供射频输入功率。') : budgetValue('dBm', inputPowerDbm);
    let gainDb = budgetValue('dB', 0);
    let factor: BudgetMetric<'ratio'> | undefined;
    const stages: RfStage[] = [];
    function appendStage(port: SignalPort, incoming?: RfStage['incoming']) {
      stages.push({
        endpoint: port.ref, powerDbm, cumulativeGainDb: gainDb, cumulativeNfDb: noiseFigure(factor), incoming,
        rating: checkInputRating(port.ref, port.definition.inputRating, powerDbm),
      });
    }
    appendStage(path.trace.steps[0].port);
    for (const edge of path.trace.edges) {
      const source = edge.source;
      let device: RfStageValues | undefined;
      if (source.kind === 'transfer' && source.transfer.kind === 'rf') {
        const instance = instances.get(JSON.stringify(edge.from.ref.instancePath));
        device = resolveRfStage(source.transfer, instance, frequencyGHz);
        // Friis weights this device's noise by the cumulative gain before the device.
        factor = appendNoise(factor, device.nfDb, gainDb);
        gainDb = addGain(gainDb, device.gainDb);
        powerDbm = addGain(powerDbm, device.gainDb);
      }
      appendStage(edge.to, { edge, device });
    }

    const nfDb = noiseFigure(factor);
    const available = [gainDb, nfDb, powerDbm].filter(metric => metric.availability === 'available').length;
    const hasStageData = stages.some(item => item.powerDbm.availability === 'available'
      || item.incoming?.device?.gainDb.availability === 'available' || item.incoming?.device?.nfDb.availability === 'available');
    const status = available === 3 ? 'valid' : available > 0 || hasStageData ? 'partial' : 'error';
    return { status, frequencyGHz, stages, gainDb, nfDb, powerDbm };
  };
}

/** Calculates budgets against a single validated V1 project snapshot. */
export function createRfBudget(project: Project) {
  const resolver = createPathResolver(project);
  const calculate = createRfPathBudget(resolver.graph);
  return {
    calculateLocal: (request: LocalPathRequest, input: RfBudgetInput) => calculate(resolver.resolveLocalPath(request), input),
    calculateNamedLink: (link: NamedLink, input: RfBudgetInput) => calculate(resolver.resolveNamedLink(link), input),
  };
}
