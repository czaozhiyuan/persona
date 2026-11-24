import type { BudgetMetric } from '../../../engine/v1/budget-metric';
import type { LinkBudgetPoint } from '../../../engine/v1/link-budget';
import type { OpticalBudget } from '../../../engine/v1/optical-budget';
import type { PathResult } from '../../../engine/v1/path-resolver';
import { signalPortKey } from '../../../engine/v1/signal-graph';
import type { SignalGraph } from '../../../engine/v1/signal-graph';
import type { EndpointRef } from '../../../model/v1/types';
import { resolveOpticalChannel } from '../../../model/v1/channels';
import { portDisplayName } from '../../../model/v1/display-names';
import { formatMetric } from '../../../workbench/v1/budgets/format-metric';
import { hierarchyKey } from './hierarchy-view';

const roles = { in: 0, out: 1, performance: 2, supplemental: 3 } as const;
type Role = keyof typeof roles;

const labels = {
  responsivity: '响应度', slope: 'K', vPi: 'Vπ', depth: '调制深度',
  gain: '增益', opticalGain: '光增益', intrinsicLoss: '最大透过插损', quadratureLoss: '正交损耗',
  averageCurrent: '平均光电流', conversionGain: '转换段增益', linkGain: '链路增益',
} as const;
type Kind = keyof typeof labels | 'power' | 'channel' | 'diagnostic';
const metricOrder: readonly string[] = ['power', ...Object.keys(labels), 'channel', 'diagnostic'];

export type Annotation = {
  text: string; detail: string; role: Role; portIndex: number; kind: Kind; channel?: string; value?: number; reason?: string;
};

function compare(a: Annotation, b: Annotation) {
  const sameRoleOrder = a.role === 'in' || a.role === 'out' ? a.portIndex - b.portIndex : 0;
  return roles[a.role] - roles[b.role] || sameRoleOrder || metricOrder.indexOf(a.kind) - metricOrder.indexOf(b.kind)
    || a.portIndex - b.portIndex || (a.channel ?? '').localeCompare(b.channel ?? '') || a.detail.localeCompare(b.detail)
    || (a.value ?? 0) - (b.value ?? 0);
}

export function captionNotes(notes: readonly Annotation[]) {
  const firstOutput = notes.findIndex(n => n.role === 'out');
  return firstOutput >= 3 && notes[0].role === 'in' ? [...notes.slice(0, 2), notes[firstOutput]] : notes.slice(0, 3);
}

export function linkAnnotations(graph: SignalGraph, path?: PathResult, point?: LinkBudgetPoint, optical?: OpticalBudget) {
  const nodes = new Map<string, Annotation[]>();
  const definitions = new Map(graph.instances.map(i => [hierarchyKey(i.instancePath), i.definition]));
  const ports = new Map<string, string>();
  function note(ref: EndpointRef, kind: Kind, role: Role, text: string,
    { reason, channel, value, p0 }: { reason?: string; channel?: string; value?: number; p0?: boolean } = {}) {
    const key = hierarchyKey(ref.instancePath);
    let notes = nodes.get(key);
    if (!notes) nodes.set(key, notes = []);
    const peers = definitions.get(key)?.ports;
    const portIndex = peers?.findIndex(p => p.id === ref.portId) ?? -1;
    const port = peers?.[portIndex];
    const detail = [port && portDisplayName(port, false, peers), text, kind !== 'channel' && channel, reason].filter(Boolean).join(' · ');
    const entry = { text, detail, role, portIndex, kind, channel, value, reason };
    const same = notes.findIndex(n => n.portIndex === portIndex && n.kind === kind && n.channel === channel
      && n.value === value && n.reason === reason && (kind === 'power' || n.text === text));
    if (same < 0) notes.push(entry);
    else if (p0) notes[same] = entry;
  }
  function metric(ref: EndpointRef, kind: keyof typeof labels, value: BudgetMetric, channel?: string) {
    note(ref, kind, 'performance', labels[kind] + ' ' + formatMetric(value),
      { channel, ...(value.availability === 'unavailable' ? { reason: value.reason } : { value: value.value }) });
  }
  function diagnostic(ref: EndpointRef, reason: string) {
    note(ref, 'diagnostic', 'supplemental', reason);
  }
  function power(ref: EndpointRef, value: BudgetMetric, channel?: string, p0 = false) {
    const key = signalPortKey(ref);
    const port = graph.ports.get(key);
    if (!port) return;
    const domain = port.definition.type === 'OPTICAL' ? '光' : 'RF ';
    const label = domain + (port.definition.direction === 'in' ? '入' : '出') + (p0 ? ' P0' : '');
    note(ref, 'power', port.definition.direction, label + ' ' + formatMetric(value), { p0, channel,
      ...(value.availability === 'unavailable' ? { reason: value.reason } : { value: value.value }) });
    if (p0) return;
    ports.set(key, [domain.trim(), formatMetric(value), channel].filter(Boolean).join(' '));
    if (channel) {
      const wavelength = resolveOpticalChannel(channel)?.wavelengthNm;
      note(ref, 'channel', 'supplemental', channel, { channel, reason: wavelength && Number.isFinite(wavelength) ? wavelength.toFixed(2) + ' nm' : undefined });
    }
  }
  function opticalStages(result: OpticalBudget) {
    for (const stage of result.stages) {
      const { endpoint, incoming } = stage;
      power(endpoint, stage.powerDbm, stage.channelId);
      if (incoming?.opticalLoss) {
        metric(endpoint, 'intrinsicLoss', incoming.opticalLoss.intrinsicLossDb, stage.channelId);
        metric(endpoint, 'quadratureLoss', incoming.opticalLoss.quadratureLossDb, stage.channelId);
      } else if (incoming?.edge.source.kind === 'transfer' || incoming?.edge.source.kind === 'switchRoute') {
        const inputChannel = incoming.edge.channels.kind === 'convert' ? incoming.edge.channels.fromChannelId : stage.channelId;
        metric(endpoint, 'opticalGain', incoming.gainDb, inputChannel);
      }
    }
    const last = result.stages.at(-1);
    if (last && result.averageCurrent) metric(last.endpoint, 'averageCurrent', result.averageCurrent, last.channelId);
    if (result.pathIssue) diagnostic(result.pathIssue.endpoint, result.pathIssue.reason);
  }
  if (optical) opticalStages(optical);
  if (point?.kind === 'rf') {
    for (const stage of point.stages) {
      power(stage.endpoint, stage.powerDbm);
      if (stage.incoming?.device) metric(stage.endpoint, 'gain', stage.incoming.device.gainDb);
    }
  }
  if (point?.kind === 'conversion' && path?.trace) {
    const cwInput = path.trace.steps[0].port.definition.type === 'OPTICAL' && path.trace.conversions[0]?.kind === 'oe';
    if (!cwInput) {
      for (const { endpoint, powerDbm } of point.rfPorts) power(endpoint, powerDbm);
      for (const stage of point.rfStages) metric(stage.output, 'gain', stage.gainDb);
    }
    for (const segment of point.segments) {
      const eo = path.trace.edges[segment.eoEdgeIndex].from.ref;
      if (segment.transmitter.kind === 'mzm') metric(eo, 'vPi', segment.transmitter.vPi);
      else {
        const output = path.trace.edges[segment.eoEdgeIndex].to.ref;
        const channels = path.trace.steps[segment.eoEdgeIndex + 1].channelIds;
        power(output, segment.transmitter.mean, channels?.length === 1 ? channels[0] : undefined, true);
        metric(eo, 'slope', segment.transmitter.slope);
        metric(path.trace.edges[segment.oeEdgeIndex].to.ref, 'conversionGain', segment.gainDb);
      }
      if (segment.optical) opticalStages(segment.optical);
      else power(segment.pdInput, segment.pdPowerDbm);
      metric(eo, 'depth', segment.modulationDepth);
      if (segment.extrapolated) diagnostic(eo, '小信号线性外推');
      metric(segment.pdInput, 'responsivity', segment.responsivity, segment.channelId);
      metric(segment.pdInput, 'averageCurrent', segment.averageCurrent, segment.channelId);
    }
    if (path.status === 'resolved' && point.segments.some(s => s.transmitter.kind === 'dml')) {
      metric(path.trace.steps.at(-1)!.port.ref, 'linkGain', point.gainDb);
    }
    if (point.partialDml) {
      const { output, optical, emission } = point.partialDml;
      if (optical) opticalStages(optical);
      else power(output, emission.mean);
      metric(output, 'slope', emission.slope);
      metric(output, 'depth', emission.modulationDepth);
      if (point.partialDml.extrapolated) diagnostic(output, '小信号线性外推');
    }
    if (point.continuousWave) {
      const cw = point.continuousWave;
      opticalStages(cw.optical);
      const channel = cw.optical.stages.at(-1)?.channelId;
      metric(cw.pdInput, 'responsivity', cw.responsivity, channel);
      metric(cw.pdInput, 'averageCurrent', cw.averageCurrent, channel);
    }
    for (const problem of point.diagnostics) if (problem.endpoint) diagnostic(problem.endpoint, problem.reason);
  }
  for (const notes of nodes.values()) notes.sort(compare);
  return { nodes, ports };
}
