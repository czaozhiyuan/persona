import { DEFAULT_CONVERSION_K } from '../../model/v1/device';
import type { ConversionProfile } from '../../model/v1/device';
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
import { isRfFrequency, resolveRfStage } from './rf-budget';
import type { RfBudgetInput } from './rf-budget';
import { signalPortKey } from './signal-graph';
import type { SignalGraph } from './signal-graph';

export type ConversionBudgetInput = RfBudgetInput & { opticalSources?: readonly OpticalSource[] };

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

const supplyFailure = {
  missing: '缺少到达调制器的供光路径。',
  ambiguous: '有多条供光路径到达调制器。',
  feedback_loop: '供光路径中存在反馈回路。',
  search_limit: '供光路径搜索超出资源上限。',
};

const noNf = () => unavailable('dB', '跨域链路未建模噪声系数。');

export function createConversionPathBudget(graph: SignalGraph, conversionProfiles: readonly ConversionProfile[] = []) {
  const opticalBudget = createOpticalBudgetForGraph(graph);
  const instances = new Map(graph.instances.map(item => [JSON.stringify(item.instancePath), item]));
  const profiles = new Map(conversionProfiles.map(profile => [profile.id, profile]));

  function opticalSegment(trace: PathTrace, eoIndex: number, oeIndex: number, sources: readonly OpticalSource[]) {
    const eo = trace.edges[eoIndex];
    const terminal = eo.supply?.ref ?? eo.to.ref;
    const supply = trace.supplies.find(item => item.edgeIndex === eoIndex);
    if (supply?.status !== 'resolved') {
      return { problem: { code: 'optical_supply', endpoint: terminal,
        reason: supply ? supplyFailure[supply.status] : '未设置调制器供光。' } } as const;
    }
    const first = supply.path.steps[0];
    const key = signalPortKey(first.port.ref);
    const candidates = sources.filter(source => signalPortKey(source.endpoint) === key
      && (first.channelIds === undefined || first.channelIds.includes(source.channelId)));
    if (candidates.length !== 1) {
      return { problem: { code: 'optical_supply', endpoint: terminal, reason: candidates.length === 0
        ? '供光通道与所选标定段不匹配。'
        : '供光功率不唯一。请为所选通道指定一个功率值。' } } as const;
    }
    const optical = opticalBudget.calculateEoPath(supply.path, candidates[0], eo, trace.edges.slice(eoIndex + 1, oeIndex));
    return { optical, channelId: optical.stages.at(-1)!.channelId };
  }

  return function calculate(path: PathResult, input: ConversionBudgetInput): ConversionBudget {
    const { frequencyGHz, inputPowerDbm, opticalSources = [] } = input;
    const diagnostics: Diagnostic[] = [];
    const segments: ConversionSegment[] = [];
    const rfStages: ExternalRfStage[] = [];

    function failed(problem: Diagnostic): ConversionBudget {
      return { status: 'error', frequencyGHz, gainDb: unavailable('dB', problem.reason), nfDb: noNf(),
        powerDbm: unavailable('dBm', problem.reason), segments, rfStages, diagnostics: [problem] };
    }
    if (!isRfFrequency(frequencyGHz)) {
      return failed({ code: 'invalid_frequency', reason: '射频频率须在 0 至 67 GHz 范围内。' });
    }
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
      block({ code: 'incomplete_conversion', reason: '跨域射频预算要求射频端点之间的电光—光电标定段完整。' });
    }
    for (const match of trace.bindings) {
      if (match.matched && match.eoEdgeIndex !== undefined && match.oeEdgeIndex === pairs.get(match.eoEdgeIndex)) {
        bindings.set(match.eoEdgeIndex, match.binding);
      } else {
        const eo = match.binding.eo;
        block({ code: 'binding_mismatch', bindingId: match.binding.id, endpoint: { instancePath: eo.instancePath, portId: eo.fromPortId },
          reason: '标定绑定未匹配所选路径上的连续电光—光电转换段。请检查边界是否超出路径、顺序颠倒或重叠。' });
      }
    }

    let gainDb = budgetValue('dB', 0);
    let powerDbm = inputPowerDbm === undefined ? unavailable('dBm', '未提供射频输入功率。') : budgetValue('dBm', inputPowerDbm);

    for (let i = 0; i < trace.edges.length; i++) {
      const edge = trace.edges[i];
      const source = edge.source;
      if (source.kind !== 'transfer') continue;
      const oeIndex = pairs.get(i);
      if (oeIndex !== undefined) {
        const pdInput = trace.edges[oeIndex].from.ref;
        const { optical, channelId, problem } = opticalSegment(trace, i, oeIndex, opticalSources);
        if (problem) diagnostics.push(problem);
        const pdPowerDbm = optical?.powerDbm ?? unavailable('dBm', problem?.reason ?? '无法确定探测器输入光功率。');
        const binding = bindings.get(i);
        const profile = binding && profiles.get(binding.profileId);
        let reference: ConversionSegment['reference'];
        let gain: BudgetMetric<'dB'>;
        if (!binding || !profile) {
          const reason = '该电光—光电转换段缺少匹配的标定绑定。';
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
            const reason = `标定方案「${profile.id}」不适用探测器通道「${channelId}」。`;
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
        powerDbm = unavailable('dBm', '该转换没有匹配的电光—光电转换段。');
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
  };
}

export function createConversionBudget(project: Project) {
  const resolver = createPathResolver(project);
  const calculate = createConversionPathBudget(resolver.graph, project.conversionProfiles);
  function calculateNamedLink(link: NamedLink, input: ConversionBudgetInput) {
    const path = resolver.resolveNamedLink(link, {
      opticalSources: input.opticalSources?.map(source => ({ ...source.endpoint, channelId: source.channelId })),
    });
    return calculate(path, input);
  }
  return { calculateNamedLink };
}
