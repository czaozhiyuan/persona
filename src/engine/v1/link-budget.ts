import type { NamedLink } from '../../model/v1/topology';
import type { EndpointRef, Project } from '../../model/v1/types';
import { unavailable } from './budget-metric';
import type { BudgetMetric } from './budget-metric';
import { createConversionPathBudget } from './conversion-budget';
import type { ConversionBudget, ConversionBudgetInput } from './conversion-budget';
import { createPathResolver } from './path-resolver';
import type { PathResult } from './path-resolver';
import { createRfPathBudget, isRfFrequency } from './rf-budget';
import type { RfBudget } from './rf-budget';

export type LinkBudgetConditions = Omit<ConversionBudgetInput, 'frequencyGHz'>;
export type LinkBudgetInput = ConversionBudgetInput;
export type RfScanRange = { startGHz: number; stopGHz: number };

type UnresolvedPoint = {
  kind: 'unresolved';
  status: 'error';
  frequencyGHz: number;
  gainDb: BudgetMetric<'dB'>;
  nfDb: BudgetMetric<'dB'>;
  powerDbm: BudgetMetric<'dBm'>;
  pathIssue: {
    status: Exclude<PathResult['status'], 'resolved'> | 'invalid_frequency' | 'not_rf';
    reason: string;
    endpoint?: EndpointRef;
  };
};

export type LinkBudgetPoint = ({ kind: 'rf' } & RfBudget) | ({ kind: 'conversion' } & ConversionBudget) | UnresolvedPoint;

/** A complete scan contains every requested frequency, even if a point has no available metrics. */
export type LinkBudgetScan =
  | { status: 'complete'; points: readonly LinkBudgetPoint[] }
  | { status: 'invalid_range'; points: readonly []; reason: string };

function unresolved(frequencyGHz: number, pathIssue: UnresolvedPoint['pathIssue']): UnresolvedPoint {
  const { reason } = pathIssue;
  return { kind: 'unresolved', status: 'error', frequencyGHz, pathIssue,
    gainDb: unavailable('dB', reason), nfDb: unavailable('dB', reason), powerDbm: unavailable('dBm', reason) };
}

/** Use a new calculator when the project snapshot changes. Each query resolves its own link and source conditions. */
export function createLinkBudget(project: Project) {
  const resolver = createPathResolver(project);
  const evaluateRf = createRfPathBudget(resolver.graph);
  const evaluateConversion = createConversionPathBudget(resolver.graph, project.conversionProfiles);

  function resolveNamedLink(link: NamedLink, conditions: LinkBudgetConditions = {}): PathResult {
    return resolver.resolveNamedLink(link, {
      opticalSources: conditions.opticalSources?.map(source => ({ ...source.endpoint, channelId: source.channelId })),
    });
  }

  function prepare(link: NamedLink, conditions: LinkBudgetConditions): (frequencyGHz: number) => LinkBudgetPoint {
    const path = resolveNamedLink(link, conditions);
    if (path.status !== 'resolved' && !path.trace) {
      return frequencyGHz => unresolved(frequencyGHz, { status: path.status, reason: path.reason, endpoint: path.endpoint });
    }
    if (path.trace?.conversions.length || path.trace?.bindings.length) {
      return frequencyGHz => ({ kind: 'conversion', ...evaluateConversion(path, { ...conditions, frequencyGHz }) });
    }
    const nonRf = path.trace?.steps.find(step => step.port.definition.type !== 'RF');
    if (nonRf) {
      return frequencyGHz => unresolved(frequencyGHz, { status: 'not_rf', endpoint: nonRf.port.ref,
        reason: '射频预算需要纯射频路径，或含电光—光电转换段的路径。' });
    }
    return frequencyGHz => ({ kind: 'rf', ...evaluateRf(path, { ...conditions, frequencyGHz }) });
  }

  function calculateNamedLink(link: NamedLink, { frequencyGHz, ...conditions }: LinkBudgetInput): LinkBudgetPoint {
    if (!isRfFrequency(frequencyGHz)) {
      return unresolved(frequencyGHz, { status: 'invalid_frequency', reason: '射频频率须在 0 至 67 GHz 范围内。' });
    }
    return prepare(link, conditions)(frequencyGHz);
  }

  function scanNamedLink(link: NamedLink, { startGHz, stopGHz }: RfScanRange,
    conditions: LinkBudgetConditions = {}): LinkBudgetScan {
    if (!Number.isInteger(startGHz) || !Number.isInteger(stopGHz)
      || !isRfFrequency(startGHz) || !isRfFrequency(stopGHz) || startGHz > stopGHz) {
      return { status: 'invalid_range', points: [],
        reason: '起止频率须为 0 至 67 GHz 范围内的整数，且起始频率不得大于终止频率。' };
    }
    const evaluate = prepare(link, conditions);
    const points: LinkBudgetPoint[] = [];
    for (let frequencyGHz = startGHz; frequencyGHz <= stopGHz; frequencyGHz++) {
      points.push(evaluate(frequencyGHz));
    }
    return { status: 'complete', points };
  }

  return { calculateNamedLink, scanNamedLink, resolveNamedLink };
}
