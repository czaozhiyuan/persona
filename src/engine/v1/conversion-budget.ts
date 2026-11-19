import { DEFAULT_CONVERSION_K } from '../../model/v1/device';
import type { OpticalChannelId } from '../../model/v1/channels';
import type { NamedLink } from '../../model/v1/topology';
import type { EndpointRef, Project } from '../../model/v1/types';
import { addGain, budgetValue, checkInputRating, unavailable } from './budget-metric';
import type { BudgetMetric, InputRatingCheck } from './budget-metric';
import { resolveEmpiricalValue } from './empirical-value';
import { createOpticalBudgetForGraph } from './optical-budget';
import type { OpticalBudget, OpticalSource } from './optical-budget';
import { createPathResolver } from './path-resolver';
import type { PathResult, PathTrace } from './path-resolver';
import { resolveRfStage } from './rf-budget';
import type { RfBudgetInput } from './rf-budget';
import { signalPortKey } from './signal-graph';

type ConversionBudgetInput = RfBudgetInput & { opticalSources?: readonly OpticalSource[] };

type ConversionSegment = {
  eoEdgeIndex: number;
  oeEdgeIndex: number;
  pdInput: EndpointRef;
  channelId?: OpticalChannelId;
  bindingId?: string;
  profileId?: string;
  reference?: { gainDb: BudgetMetric<'dB'>; pdPowerDbm: number; k: number };
  optical?: OpticalBudget;
  pdPowerDbm: BudgetMetric<'dBm'>;
  gainDb: BudgetMetric<'dB'>;
  rfOutputDbm: BudgetMetric<'dBm'>;
};

type ExternalRfStage = ReturnType<typeof resolveRfStage> & {
  edgeIndex: number;
  input: EndpointRef;
  output: EndpointRef;
  powerDbm: BudgetMetric<'dBm'>;
  rating?: InputRatingCheck;
};

type Diagnostic = {
  code: Exclude<PathResult['status'], 'resolved'> | 'invalid_frequency' | 'incomplete_conversion'
    | 'binding_mismatch' | 'missing_binding' | 'optical_supply' | 'profile_channel' | 'missing_gain';
  reason: string;
  endpoint?: EndpointRef;
  bindingId?: string;
};

export type ConversionBudget = {
  status: 'partial' | 'error';
  frequencyGHz: number;
  gainDb: BudgetMetric<'dB'>;
  nfDb: BudgetMetric<'dB'>;
  powerDbm: BudgetMetric<'dBm'>;
  segments: readonly ConversionSegment[];
  rfStages: readonly ExternalRfStage[];
  diagnostics: readonly Diagnostic[];
};

const noNf = () => unavailable('dB', 'Cross-domain noise figure is not modeled.');

export function createConversionBudget(project: Project) {
  const resolver = createPathResolver(project);
  const opticalBudget = createOpticalBudgetForGraph(resolver.graph);
  const instances = new Map(resolver.graph.instances.map(item => [JSON.stringify(item.instancePath), item]));
  const profiles = new Map(project.conversionProfiles?.map(profile => [profile.id, profile]));

  function opticalSegment(trace: PathTrace, eoIndex: number, oeIndex: number, sources: readonly OpticalSource[]) {
    const eo = trace.edges[eoIndex];
    const terminal = eo.supply?.ref ?? eo.to.ref;
    const supply = trace.supplies.find(item => item.edgeIndex === eoIndex);
    if (supply?.status !== 'resolved') {
      return { problem: { code: 'optical_supply', endpoint: terminal,
        reason: `EO optical supply is ${supply?.status ?? 'not declared'}.` } } as const;
    }
    const first = supply.path.steps[0];
    const key = signalPortKey(first.port.ref);
    const candidates = sources.filter(source => signalPortKey(source.endpoint) === key
      && (first.channelIds === undefined || first.channelIds.includes(source.channelId)));
    if (candidates.length !== 1) {
      return { problem: { code: 'optical_supply', endpoint: terminal, reason: candidates.length === 0
        ? 'No supplied optical channel matches the selected span.'
        : 'The optical supply power is ambiguous. Specify one value on the selected channel.' } } as const;
    }
    const optical = opticalBudget.calculateEoPath(supply.path, candidates[0], eo, trace.edges.slice(eoIndex + 1, oeIndex));
    return { optical, channelId: optical.stages.at(-1)!.channelId };
  }

  function calculateNamedLink(link: NamedLink, input: ConversionBudgetInput): ConversionBudget {
    const { frequencyGHz, inputPowerDbm, opticalSources = [] } = input;
    const diagnostics: Diagnostic[] = [];
    const segments: ConversionSegment[] = [];
    const rfStages: ExternalRfStage[] = [];

    function failed(problem: Diagnostic): ConversionBudget {
      return { status: 'error', frequencyGHz, gainDb: unavailable('dB', problem.reason), nfDb: noNf(),
        powerDbm: unavailable('dBm', problem.reason), segments, rfStages, diagnostics: [problem] };
    }
    if (!Number.isFinite(frequencyGHz) || frequencyGHz < 0 || frequencyGHz > 67) {
      return failed({ code: 'invalid_frequency', reason: 'RF frequency must be between 0 and 67 GHz.' });
    }
    const path = resolver.resolveNamedLink(link, {
      opticalSources: opticalSources.map(source => ({ ...source.endpoint, channelId: source.channelId })),
    });
    let blocked: Diagnostic | undefined;
    if (path.status !== 'resolved') {
      blocked = { code: path.status, endpoint: path.endpoint, reason: path.reason };
      if (!path.trace) return failed(blocked);
      diagnostics.push(blocked);
    }
    const trace = path.trace!;
    const pairs = new Map<number, number>();
    for (const [i, eo] of trace.conversions.entries()) {
      const oe = trace.conversions[i + 1];
      if (eo.kind === 'eo' && oe?.kind === 'oe') pairs.set(eo.edgeIndex, oe.edgeIndex);
    }
    const bindings = new Map<number, PathTrace['bindings'][number]['binding']>();
    function block(problem: Diagnostic) {
      blocked ??= problem;
      diagnostics.push(problem);
    }
    if (!pairs.size || pairs.size * 2 !== trace.conversions.length
      || trace.steps[0].port.definition.type !== 'RF' || trace.steps.at(-1)?.port.definition.type !== 'RF') {
      block({ code: 'incomplete_conversion', reason: 'A cross-domain RF budget requires complete EO→OE spans between RF endpoints.' });
    }
    for (const match of trace.bindings) {
      if (match.matched && match.eoEdgeIndex !== undefined && match.oeEdgeIndex === pairs.get(match.eoEdgeIndex)) {
        bindings.set(match.eoEdgeIndex, match.binding);
      } else {
        const eo = match.binding.eo;
        block({ code: 'binding_mismatch', bindingId: match.binding.id, endpoint: { instancePath: eo.instancePath, portId: eo.fromPortId },
          reason: 'The binding does not match one consecutive EO→OE span on the selected path. Its boundaries may be outside, reversed or overlapping.' });
      }
    }

    let gainDb = budgetValue('dB', 0);
    let powerDbm = inputPowerDbm === undefined ? unavailable('dBm', 'The RF input power is not provided.') : budgetValue('dBm', inputPowerDbm);

    for (let i = 0; i < trace.edges.length; i++) {
      const edge = trace.edges[i];
      const source = edge.source;
      if (source.kind !== 'transfer') continue;
      const oeIndex = pairs.get(i);
      if (oeIndex !== undefined) {
        const pdInput = trace.edges[oeIndex].from.ref;
        const { optical, channelId, problem } = opticalSegment(trace, i, oeIndex, opticalSources);
        if (problem) diagnostics.push(problem);
        const pdPowerDbm = optical?.powerDbm ?? unavailable('dBm', problem?.reason ?? 'PD input power is unavailable.');
        const binding = bindings.get(i);
        const profile = binding && profiles.get(binding.profileId);
        let reference: ConversionSegment['reference'];
        let gain: BudgetMetric<'dB'>;
        if (!binding || !profile) {
          const reason = 'No matching calibration binding exists for this EO→OE span.';
          diagnostics.push({ code: 'missing_binding', endpoint: pdInput, reason });
          gain = unavailable('dB', reason);
        } else {
          reference = {
            gainDb: resolveEmpiricalValue('dB', binding.overrides?.rfGainRefDb ?? profile.rfGainRefDb, { frequencyGHz }),
            pdPowerDbm: binding.overrides?.pdPowerRefDbm ?? profile.pdPowerRefDbm,
            k: binding.overrides?.k ?? profile.k ?? DEFAULT_CONVERSION_K,
          };
          const outsideProfile = channelId !== undefined && profile.applicability?.channelIds && !profile.applicability.channelIds.includes(channelId);
          if (outsideProfile) {
            const reason = `Calibration profile "${profile.id}" does not cover PD channel "${channelId}".`;
            gain = unavailable('dB', reason);
          } else if (pdPowerDbm.availability === 'unavailable') {
            gain = unavailable('dB', pdPowerDbm.reason);
          } else if (reference.gainDb.availability === 'unavailable') {
            gain = reference.gainDb;
          } else {
            gain = budgetValue('dB', reference.gainDb.value + reference.k * (pdPowerDbm.value - reference.pdPowerDbm));
          }
          if (gain.availability === 'unavailable') {
            diagnostics.push({ code: outsideProfile ? 'profile_channel' : 'missing_gain',
              endpoint: pdInput, bindingId: binding.id, reason: gain.reason });
          }
        }
        // Only the calibrated contribution crosses the optical span into the RF budget.
        gainDb = addGain(gainDb, gain);
        powerDbm = addGain(powerDbm, gain);
        segments.push({ eoEdgeIndex: i, oeEdgeIndex: oeIndex, pdInput, channelId, bindingId: binding?.id, profileId: profile?.id,
          reference, optical, pdPowerDbm, gainDb: gain, rfOutputDbm: powerDbm });
        i = oeIndex;
      } else if (source.transfer.kind === 'rf') {
        const instance = instances.get(JSON.stringify(edge.from.ref.instancePath));
        const values = resolveRfStage(source.transfer, instance, frequencyGHz);
        const rating = checkInputRating(edge.from.ref, edge.from.definition.inputRating, powerDbm);
        gainDb = addGain(gainDb, values.gainDb);
        powerDbm = addGain(powerDbm, values.gainDb);
        rfStages.push({ edgeIndex: i, input: edge.from.ref, output: edge.to.ref, ...values, powerDbm, rating });
        if (values.gainDb.availability === 'unavailable') diagnostics.push({ code: 'missing_gain',
          endpoint: edge.from.ref, reason: values.gainDb.reason });
      } else if (source.transfer.kind === 'eo' || source.transfer.kind === 'oe') {
        powerDbm = unavailable('dBm', 'This conversion has no matching EO→OE span.');
      }
    }

    if (blocked) {
      gainDb = unavailable('dB', blocked.reason);
      powerDbm = unavailable('dBm', blocked.reason);
    }
    const hasResults = gainDb.availability === 'available' || segments.some(segment =>
      segment.optical && segment.optical.status !== 'error' || segment.gainDb.availability === 'available')
      || rfStages.some(stage => stage.gainDb.availability === 'available' || stage.nfDb.availability === 'available');
    return { status: hasResults ? 'partial' : 'error', frequencyGHz, gainDb, powerDbm, nfDb: noNf(), segments, rfStages, diagnostics };
  }

  return { calculateNamedLink };
}
