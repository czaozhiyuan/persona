import { portKey, type Empirical, type Link, type Project } from '../model/types';
import { buildGraph, traceLink, type Arc, type Graph } from './graph';

export function evaluate(value: Empirical | string | undefined, frequencyGHz: number, channelId?: string): number {
  if (!value || typeof value === 'string') throw new Error('缺失必要经验参数');
  let result: number | undefined;
  if (value.kind === 'fixed') result = value.value;
  else if (value.kind === 'channel') {
    if (!channelId || !Object.hasOwn(value.values, channelId)) throw new Error(`通道表不支持：${channelId ?? '未选择'}`);
    result = value.values[channelId];
  } else {
    const points = value.points;
    if (!points.length || frequencyGHz < points[0][0] || frequencyGHz > points.at(-1)![0]) throw new Error(`超出 RF 曲线有效范围：${frequencyGHz} GHz`);
    for (let i = 0; i < points.length; i++) {
      if (frequencyGHz === points[i][0]) { result = points[i][1]; break; }
      if (i > 0 && frequencyGHz < points[i][0]) {
        const [x0, y0] = points[i - 1], [x1, y1] = points[i];
        result = y0 + (y1 - y0) * (frequencyGHz - x0) / (x1 - x0);
        break;
      }
    }
  }
  if (result === undefined || !Number.isFinite(result)) throw new Error('经验参数不是有限数值');
  return result;
}

function supplyPower(graph: Graph, target: string, f: number, channel: string | undefined, visited = new Set<string>()): { power: number; arcs: Arc[] } {
  if (visited.has(target)) throw new Error('激光供光路径有环');
  const next = new Set([...visited, target]);
  const owner = graph.instances.find(i => i.id === target.split(':')[0]);
  const port = graph.ports.get(target);
  if (owner && port?.type === 'OPTICAL' && port.direction === 'out' && owner.params.powerDbm !== undefined) {
    if (owner.params.channel !== channel) throw new Error('激光供光通道不匹配');
    return { power: evaluate(owner.params.powerDbm, f, channel), arcs: [] };
  }
  const incoming = graph.arcs.filter(a => a.to === target && ['connection', 'mapping', 'optical', 'eo'].includes(a.kind));
  if (incoming.length !== 1) throw new Error(`激光供光路径${incoming.length ? '存在歧义' : '缺失'}：${target}`);
  const arc = incoming[0];
  if (arc.kind === 'eo') {
    const source = graph.instances.find(i => i.id === arc.instanceId)!;
    const upstream = supplyPower(graph, `${arc.instanceId}:${arc.transfer!.supplyPort}`, f, channel, next);
    return { power: upstream.power + evaluate(source.params.opticalGainDb, f, channel), arcs: [...upstream.arcs, arc] };
  }
  const upstream = supplyPower(graph, arc.from, f, channel, next);
  const gain = arc.kind === 'mapping' ? 0 : evaluate(arc.connection?.gainDb ?? arc.transfer?.gainDb, f, channel);
  return { power: upstream.power + gain, arcs: [...upstream.arcs, arc] };
}

export type StageResult = { label: string; kind: string; gainDb?: number; opticalPowerDbm?: number; rfGainDb?: number; error?: string };
export type CalculationResult = {
  status: 'ok' | 'partial' | 'error'; errors: string[]; frequencyGHz: number;
  rfGainDb?: number; opticalPowerDbm?: number; nfDb?: number;
  stages: StageResult[]; path: Arc[]; highlightNodes: string[]; highlightConnections: string[];
};

export function calculate(project: Project, link: Link, frequencyGHz = 1): CalculationResult {
  const result: CalculationResult = { status: 'error', errors: [], frequencyGHz, stages: [], path: [], highlightNodes: [], highlightConnections: [] };
  try {
    if (!Number.isFinite(frequencyGHz)) throw new Error('RF 频率必须是有限数值');
    const trace = traceLink(project, link);
    if (trace.status !== 'ok') throw new Error(trace.message);
    const graph = buildGraph(project, link.channelId);
    result.path = trace.arcs;
    let rf: number | undefined = 0, optical: number | undefined;
    let noiseFactor = 1, previousGain = 1, noiseValid = true, eoCount = 0, oeCount = 0;
    const highlighted = [...trace.arcs];
    for (const arc of trace.arcs) {
      if (arc.kind === 'mapping') continue;
      const stage: StageResult = { label: arc.id, kind: arc.kind };
      try {
        if (arc.kind === 'eo') {
          eoCount++;
          const item = graph.instances.find(i => i.id === arc.instanceId)!;
          const supply = supplyPower(graph, `${arc.instanceId}:${arc.transfer!.supplyPort}`, frequencyGHz, link.channelId);
          highlighted.push(...supply.arcs);
          stage.gainDb = evaluate(item.params.opticalGainDb, frequencyGHz, link.channelId);
          optical = supply.power + stage.gainDb;
          noiseValid = false;
        } else if (arc.kind === 'oe') {
          oeCount++;
          if (optical === undefined) throw new Error('缺少 PD 接收光功率');
          const reference = link.conversion;
          if (!reference || !Object.values(reference).every(Number.isFinite)) throw new Error('缺少整段经验转换基准或 K');
          stage.gainDb = reference.gainRefDb + reference.k * (optical - reference.powerRefDbm);
          if (rf !== undefined) rf += stage.gainDb;
          noiseValid = false;
        } else {
          const gain = evaluate(arc.connection?.gainDb ?? arc.transfer?.gainDb, frequencyGHz, link.channelId);
          stage.gainDb = gain;
          const opticalArc = graph.ports.get(arc.from)?.type === 'OPTICAL';
          if (opticalArc) {
            if (optical === undefined) {
              const supply = supplyPower(graph, arc.from, frequencyGHz, link.channelId);
              optical = supply.power;
              highlighted.push(...supply.arcs);
            }
            optical += gain;
          } else if (graph.ports.get(arc.from)?.type === 'RF') {
            if (rf !== undefined) rf += gain;
            if (arc.kind === 'rf') {
              if (arc.transfer?.nfDb) noiseFactor += (10 ** (evaluate(arc.transfer.nfDb, frequencyGHz, link.channelId) / 10) - 1) / previousGain;
              else noiseValid = false;
            } else if (gain <= 0) {
              noiseFactor += (10 ** (-gain / 10) - 1) / previousGain;
            } else noiseValid = false;
            previousGain *= 10 ** (gain / 10);
          }
        }
      } catch (e) {
        stage.error = (e as Error).message;
        result.errors.push(`${arc.id}：${stage.error}`);
        if (arc.kind === 'oe' || arc.kind === 'rf' || graph.ports.get(arc.from)?.type === 'RF') rf = undefined;
        if (arc.kind === 'eo' || graph.ports.get(arc.from)?.type === 'OPTICAL' && arc.kind !== 'oe') optical = undefined;
        noiseValid = false;
      }
      stage.opticalPowerDbm = optical;
      stage.rfGainDb = rf;
      result.stages.push(stage);
    }
    if (eoCount !== oeCount || eoCount > 1) {
      result.errors.push('P0 仅计算一个完整 EO→OE 整段经验转换');
      rf = undefined;
    }
    const destinationType = graph.ports.get(portKey(link.to))?.type;
    result.rfGainDb = destinationType === 'RF' ? rf : undefined;
    result.opticalPowerDbm = optical;
    if (noiseValid && destinationType === 'RF') result.nfDb = 10 * Math.log10(noiseFactor);
    result.highlightConnections = [...new Set(highlighted.filter(a => a.kind === 'connection' || a.kind === 'mapping').map(a => a.id))];
    result.highlightNodes = [...new Set(highlighted.flatMap(a => [a.from.split(':')[0], a.to.split(':')[0]]))];
    result.status = result.errors.length ? (result.rfGainDb !== undefined || optical !== undefined ? 'partial' : 'error') : 'ok';
  } catch (e) { result.errors.push((e as Error).message); }
  return result;
}

export function scan(project: Project, link: Link): CalculationResult[] {
  return [1, 2, 3, 4, 5].map(frequency => calculate(project, link, frequency));
}
