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

type Note = { text: string; detail: string; priority: number };

export function linkAnnotations(graph: SignalGraph, path?: PathResult, point?: LinkBudgetPoint, optical?: OpticalBudget) {
  const nodes = new Map<string, Note[]>();
  const ports = new Map<string, string>();
  function note(ref: EndpointRef, text: string, reason?: string, priority = 1) {
    const key = hierarchyKey(ref.instancePath);
    let notes = nodes.get(key);
    if (!notes) nodes.set(key, notes = []);
    const port = graph.ports.get(signalPortKey(ref));
    const detail = [port && portDisplayName(port.definition), text, reason].filter(Boolean).join(' · ');
    if (!notes.some(n => n.detail === detail)) notes.push({ text, detail, priority });
  }
  function metric(ref: EndpointRef, label: string, value: BudgetMetric, priority = 1) {
    note(ref, label + ' ' + formatMetric(value), value.availability === 'unavailable' ? value.reason : undefined, priority);
  }
  function power(ref: EndpointRef, value: BudgetMetric, channel?: string) {
    const key = signalPortKey(ref);
    const port = graph.ports.get(key);
    if (!port) return;
    const domain = port.definition.type === 'OPTICAL' ? '光' : 'RF ';
    metric(ref, domain + (port.definition.direction === 'in' ? '入' : '出'), value, 0);
    ports.set(key, [domain.trim(), formatMetric(value), channel].filter(Boolean).join(' '));
    if (channel) {
      const wavelength = resolveOpticalChannel(channel)?.wavelengthNm;
      note(ref, channel, wavelength && Number.isFinite(wavelength) ? wavelength.toFixed(2) + ' nm' : undefined, 2);
    }
  }
  function opticalStages(result: OpticalBudget) {
    for (const stage of result.stages) {
      const { endpoint, incoming } = stage;
      power(endpoint, stage.powerDbm, stage.channelId);
      if (incoming?.opticalLoss) {
        metric(endpoint, '最大透过插损', incoming.opticalLoss.intrinsicLossDb);
        metric(endpoint, '正交损耗', incoming.opticalLoss.quadratureLossDb);
      } else if (incoming?.edge.source.kind === 'transfer' || incoming?.edge.source.kind === 'switchRoute') {
        metric(endpoint, '光增益', incoming.gainDb);
      }
    }
    const last = result.stages.at(-1);
    if (last && result.averageCurrent) metric(last.endpoint, '平均光电流', result.averageCurrent, 2);
    if (result.pathIssue) note(result.pathIssue.endpoint, result.pathIssue.reason);
  }
  if (optical) opticalStages(optical);
  if (point?.kind === 'rf') {
    for (const stage of point.stages) {
      power(stage.endpoint, stage.powerDbm);
      if (stage.incoming?.device) metric(stage.endpoint, '增益', stage.incoming.device.gainDb);
    }
  }
  if (point?.kind === 'conversion' && path?.trace) {
    const cwInput = path.trace.steps[0].port.definition.type === 'OPTICAL' && path.trace.conversions[0]?.kind === 'oe';
    if (!cwInput) {
      for (const { endpoint, powerDbm } of point.rfPorts) power(endpoint, powerDbm);
      for (const stage of point.rfStages) metric(stage.output, '增益', stage.gainDb);
    }
    for (const segment of point.segments) {
      const eo = path.trace.edges[segment.eoEdgeIndex].from.ref;
      if (segment.transmitter.kind === 'mzm') metric(eo, 'Vπ', segment.transmitter.vPi);
      else {
        metric(path.trace.edges[segment.eoEdgeIndex].to.ref, 'P0', segment.transmitter.mean, -1);
        metric(eo, 'K', segment.transmitter.slope, -1);
        metric(eo, '调制深度', segment.modulationDepth, -1);
        metric(path.trace.edges[segment.oeEdgeIndex].to.ref, '转换段增益', segment.gainDb);
      }
      if (segment.optical) opticalStages(segment.optical);
      else power(segment.pdInput, segment.pdPowerDbm);
      metric(eo, '调制深度', segment.modulationDepth, 2);
      if (segment.extrapolated) note(eo, '小信号线性外推');
      metric(segment.pdInput, '响应度', segment.responsivity);
      metric(segment.pdInput, '平均光电流', segment.averageCurrent);
    }
    if (point.segments.some(s => s.transmitter.kind === 'dml')) {
      metric(path.trace.steps.at(-1)!.port.ref, '链路增益', point.gainDb);
    }
    if (point.partialDml) {
      const { output, optical, emission } = point.partialDml;
      if (optical) opticalStages(optical);
      else power(output, emission.mean);
      metric(output, 'K', emission.slope);
      metric(output, '调制深度', emission.modulationDepth, 2);
      if (point.partialDml.extrapolated) note(output, '小信号线性外推');
    }
    if (point.continuousWave) {
      const cw = point.continuousWave;
      opticalStages(cw.optical);
      metric(cw.pdInput, '响应度', cw.responsivity);
      metric(cw.pdInput, '平均光电流', cw.averageCurrent);
    }
    for (const problem of point.diagnostics) if (problem.endpoint) note(problem.endpoint, problem.reason);
  }
  for (const notes of nodes.values()) notes.sort((a, b) => a.priority - b.priority);
  return { nodes, ports };
}
