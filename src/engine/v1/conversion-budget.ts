import type { OpticalChannelId } from '../../model/v1/channels';
import { loadedResponse } from './receiver-response';
import type { NamedLink } from '../../model/v1/topology';
import type { EndpointRef, Project } from '../../model/v1/types';
import { addGain, budgetValue, checkInputRating, logZero, unavailable } from './budget-metric';
import type { BudgetMetric, InputRatingCheck } from './budget-metric';
import { resolveEmpiricalValue } from './empirical-value';
import { createOpticalBudgetForGraph, photocurrent } from './optical-budget';
import type { OpticalBudget, OpticalSource } from './optical-budget';
import { createPathResolver } from './path-resolver';
import type { PathResult, PathTrace } from './path-resolver';
import type { SignalStep } from './path-search';
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
  modulationDepth: BudgetMetric<'ratio'>;
  averageCurrent: BudgetMetric<'A'>;
  inputRating?: InputRatingCheck;
  extrapolated: boolean;
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
    | 'optical_supply' | 'missing_gain';
  reason: string;
  endpoint?: EndpointRef;
};

export function loadedVoltages(power: BudgetMetric<'dBm'>) {
  if (power.availability === 'unavailable') return { vrms: unavailable('V', power.reason), vpp: unavailable('V', power.reason) };
  const rms = Math.sqrt(50 * 10 ** ((power.value - 30) / 10));
  return { vrms: budgetValue('V', rms), vpp: budgetValue('V', 2 * Math.SQRT2 * rms) };
}

export type ConversionBudget = {
  status: 'partial' | 'error';
  frequencyGHz: number;
  gainDb: BudgetMetric<'dB'>;
  nfDb: BudgetMetric<'dB'>;
  powerDbm: BudgetMetric<'dBm'>;
  segments: readonly ConversionSegment[];
  rfStages: readonly ExternalRfStage[];
  continuousWave?: { pdInput: EndpointRef; optical: OpticalBudget; averageCurrent: BudgetMetric<'A'> };
  diagnostics: readonly Diagnostic[];
};

const supplyFailure = {
  missing: '缺少到达调制器的供光路径。',
  ambiguous: '有多条供光路径到达调制器。',
  feedback_loop: '供光路径中存在反馈回路。',
  search_limit: '供光路径搜索超出资源上限。',
};

const noNf = () => unavailable('dB', '跨域链路未建模噪声系数。');

function selectOpticalSource(first: SignalStep, sources: readonly OpticalSource[]): OpticalSource | undefined {
  const key = signalPortKey(first.port.ref);
  const candidates = sources.filter(source => signalPortKey(source.endpoint) === key
    && (first.channelIds === undefined || first.channelIds.includes(source.channelId)));
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length && first.channelIds?.length === 1) {
    return { endpoint: first.port.ref, channelId: first.channelIds[0] };
  }
}

export function createConversionPathBudget(graph: SignalGraph) {
  const opticalBudget = createOpticalBudgetForGraph(graph);
  const instances = new Map(graph.instances.map(item => [JSON.stringify(item.instancePath), item]));

  function opticalSegment(trace: PathTrace, eoIndex: number, oeIndex: number, sources: readonly OpticalSource[]) {
    const eo = trace.edges[eoIndex];
    const terminal = eo.supply?.ref ?? eo.to.ref;
    const supply = trace.supplies.find(item => item.edgeIndex === eoIndex);
    if (supply?.status !== 'resolved') {
      return { problem: { code: 'optical_supply', endpoint: terminal,
        reason: supply ? supplyFailure[supply.status] : '未设置调制器供光。' } } as const;
    }
    const first = supply.path.steps[0];
    const source = selectOpticalSource(first, sources);
    if (!source) return { problem: { code: 'optical_supply', endpoint: first.port.ref, reason: '请选择唯一的供光端口和通道。' } } as const;
    const optical = opticalBudget.calculateEoPath(supply.path, source, eo, trace.edges.slice(eoIndex + 1, oeIndex));
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
    const first = trace.steps[0];
    const firstConversion = trace.conversions[0];
    let continuousWave: ConversionBudget['continuousWave'];
    if (first.port.definition.type === 'OPTICAL' && firstConversion?.kind === 'oe') {
      const index = firstConversion.edgeIndex;
      const edge = trace.edges[index];
      const source = selectOpticalSource(first, opticalSources);
      if (!source) {
        block({ code: 'optical_supply', endpoint: first.port.ref, reason: '请选择唯一的供光端口和通道。' });
      } else if (edge.source.kind === 'transfer' && edge.source.transfer.kind === 'oe') {
        const optical = opticalBudget.calculateOpticalPath({ steps: trace.steps.slice(0, index + 1), edges: trace.edges.slice(0, index) }, source);
        const rho = resolveEmpiricalValue('A/W', edge.source.transfer.responsivity, { channelId: optical.stages.at(-1)?.channelId },
          instances.get(JSON.stringify(edge.from.ref.instancePath)));
        const averageCurrent = photocurrent(optical.powerDbm, rho);
        continuousWave = { pdInput: edge.from.ref, optical, averageCurrent };
        block({ code: 'incomplete_conversion', reason: '连续光未携带射频调制。' });
      }
    }
    const pairs = new Map<number, number>();
    for (const [i, eo] of trace.conversions.entries()) {
      const oe = trace.conversions[i + 1];
      if (eo.kind === 'eo' && oe?.kind === 'oe') pairs.set(eo.edgeIndex, oe.edgeIndex);
    }
    function block(problem: Diagnostic) {
      blocked ??= problem;
      diagnostics.push(problem);
    }
    if (!blocked && (!pairs.size || pairs.size * 2 !== trace.conversions.length
      || first.port.definition.type !== 'RF' || trace.steps.at(-1)?.port.definition.type !== 'RF')) {
      block({ code: 'incomplete_conversion', reason: '跨域射频预算要求射频端点之间的电光—光电段完整。' });
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
        const receiver = trace.edges[oeIndex].source;
        if (source.transfer.kind !== 'eo' || receiver.kind !== 'transfer' || receiver.transfer.kind !== 'oe') continue;
        const eoInput = edge.from.ref;
        const modulator = instances.get(JSON.stringify(eoInput.instancePath));
        const detector = instances.get(JSON.stringify(pdInput.instancePath));
        const pd = receiver.transfer;
        const query = { frequencyGHz, channelId };
        const vPi = resolveEmpiricalValue('V', source.transfer.vPi, query, modulator);
        const rho = resolveEmpiricalValue('A/W', pd.responsivity, query, detector);
        const conversion = loadedResponse(pd, detector, rho, frequencyGHz);
        const averageCurrent = photocurrent(pdPowerDbm, rho);
        const modulationDepth = vPi.availability === 'unavailable' ? unavailable('ratio', `RF Vπ：${vPi.reason}`)
          : powerDbm.availability === 'unavailable' ? unavailable('ratio', powerDbm.reason)
          : budgetValue('ratio', Math.PI * Math.sqrt(100 * 10 ** ((powerDbm.value - 30) / 10)) / vPi.value);
        const gain = vPi.availability === 'unavailable' ? unavailable('dB', `${eoInput.instancePath.join('/')} RF Vπ：${vPi.reason}`)
          : conversion.availability === 'unavailable' ? unavailable('dB', `${pdInput.instancePath.join('/')} 光电转换：${conversion.reason}`)
          : pdPowerDbm.availability === 'unavailable' ? unavailable('dB', pdPowerDbm.reason)
          : conversion.value === 0 ? logZero('dB')
          : budgetValue('dB', 2 * (pdPowerDbm.value - 30) + 20 * Math.log10(Math.PI * Math.abs(conversion.value) / vPi.value));
        if (gain.availability === 'unavailable') diagnostics.push({ code: 'missing_gain',
          endpoint: vPi.availability === 'unavailable' ? eoInput : pdInput, reason: gain.reason });
        const inputRating = checkInputRating(eoInput, edge.from.definition.inputRating, powerDbm);
        gainDb = addGain(gainDb, gain);
        powerDbm = addGain(powerDbm, gain);
        segments.push({ eoEdgeIndex: i, oeEdgeIndex: oeIndex, pdInput, channelId, optical, pdPowerDbm, inputRating,
          gainDb: gain, rfOutputDbm: powerDbm, modulationDepth, averageCurrent,
          extrapolated: modulationDepth.availability === 'available' && modulationDepth.value > 0.3 });
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
    const hasResults = continuousWave?.optical.powerDbm.availability === 'available' || gainDb.availability === 'available' || segments.some(segment =>
      segment.optical && segment.optical.status !== 'error' || segment.gainDb.availability === 'available')
      || rfStages.some(stage => stage.gainDb.availability === 'available' || stage.nfDb.availability === 'available');
    return { status: hasResults ? 'partial' : 'error', frequencyGHz, gainDb, powerDbm, nfDb: noNf(), segments, rfStages, continuousWave, diagnostics };
  };
}

export function createConversionBudget(project: Project) {
  const resolver = createPathResolver(project);
  const calculate = createConversionPathBudget(resolver.graph);
  function calculateNamedLink(link: NamedLink, input: ConversionBudgetInput) {
    const path = resolver.resolveNamedLink(link, {
      opticalSources: input.opticalSources?.map(source => ({ ...source.endpoint, channelId: source.channelId })),
    });
    return calculate(path, input);
  }
  return { calculateNamedLink };
}
