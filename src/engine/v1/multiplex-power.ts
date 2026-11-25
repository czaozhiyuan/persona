import type { OpticalChannelId } from '../../model/v1/channels';
import { portDisplayName } from '../../model/v1/display-names';
import type { EndpointRef, PortFlow } from '../../model/v1/types';
import { budgetValue, logZero, unavailable, type BudgetMetric } from './budget-metric';
import { createOpticalBudgetForGraph } from './optical-budget';
import { createPathNames } from './path-names';
import { cochannelConflict, createOpticalOrigins } from './optical-origins';
import type { OpticalSource } from '../../model/v1/topology';
import { signalPortKey, type SignalGraph, type SignalPort } from './signal-graph';

export type MultiplexWave = {
  channelId: OpticalChannelId;
  flow: PortFlow;
  sources: readonly EndpointRef[];
  power: BudgetMetric<'dBm'>;
};
export type MultiplexTotal = { known: BudgetMetric<'dBm'>; partial: boolean };
export type MultiplexPoint = { ref: EndpointRef; waves: MultiplexWave[]; in: MultiplexTotal; out: MultiplexTotal };

function total(waves: readonly MultiplexWave[]): MultiplexTotal {
  const values = waves.flatMap(w => w.power.availability === 'available' ? [w.power.value] : []);
  const partial = values.length < waves.length;
  if (!values.length) return { known: unavailable('dBm', partial ? '各通道功率均未确定。' : '没有活动通道。'), partial };
  const max = Math.max(...values);
  // Sum in linear units relative to the largest carrier to avoid overflow.
  const known = max === -Infinity ? logZero('dBm')
    : budgetValue('dBm', max + 10 * Math.log10(values.reduce((sum, p) => sum + 10 ** ((p - max) / 10), 0)));
  return { known, partial };
}

export function createMultiplexPower(graph: SignalGraph, trials: readonly OpticalSource[] = []) {
  const channelsAt = new Map<SignalPort, Set<OpticalChannelId>>();
  const cached = new Map<SignalPort, MultiplexPoint>();
  const commons = new Map<SignalPort, OpticalChannelId[]>();
  const branches = new Set<SignalPort>();
  for (const { definition, instancePath } of graph.instances) {
    if (definition.kind !== 'component' || !definition.wdm) continue;
    const channels: OpticalChannelId[] = [];
    for (const port of definition.ports) {
      const node = graph.ports.get(signalPortKey({ instancePath, portId: port.id }))!;
      if (port.id === 'COM') commons.set(node, channels);
      else {
        branches.add(node);
        channels.push(...(port.channelIds ?? []));
      }
    }
  }
  const neighbours = new Map<SignalPort, Set<SignalPort>>();
  function connect(a: SignalPort, b: SignalPort) {
    let peers = neighbours.get(a);
    if (!peers) neighbours.set(a, peers = new Set());
    peers.add(b);
  }
  for (const edge of commons.size ? graph.edges : []) {
    if (edge.from.definition.type !== 'OPTICAL' || edge.to.definition.type !== 'OPTICAL'
      || branches.has(edge.from) || branches.has(edge.to)) continue;
    connect(edge.from, edge.to);
    connect(edge.to, edge.from);
  }
  for (const com of commons.keys()) {
    if (channelsAt.has(com)) continue;
    const trunk = new Set([com]);
    const channels = new Set<OpticalChannelId>();
    for (const port of trunk) {
      for (const channel of commons.get(port) ?? []) channels.add(channel);
      for (const peer of neighbours.get(port) ?? []) trunk.add(peer);
      channelsAt.set(port, channels);
    }
  }
  let origins: ReturnType<typeof createOpticalOrigins> | undefined;
  let budget: ReturnType<typeof createOpticalBudgetForGraph> | undefined;
  function readWave(ref: EndpointRef, channelId: OpticalChannelId, flow: PortFlow): MultiplexWave | undefined {
    const port = graph.ports.get(signalPortKey(ref));
    if (!port || port.definition.type !== 'OPTICAL'
      || (port.definition.direction !== 'bidirectional' && port.definition.direction !== flow)) return;
    origins ??= createOpticalOrigins(graph, trials);
    const { paths, unresolved, dark } = origins(port, channelId, flow, true);
    const sources = [...paths.map(p => p.source.endpoint), ...unresolved];
    if (dark) return { channelId, flow, sources, power: logZero('dBm') };
    if (!sources.length) return;
    if (unresolved.length || paths.length > 1) return { channelId, flow, sources, power: unavailable('dBm', cochannelConflict) };
    budget ??= createOpticalBudgetForGraph(graph, origins);
    const { source, path, modulator } = paths[0];
    const result = modulator ? budget.calculateEoPath(modulator.supply, source, modulator.eo, path.edges)
      : budget.calculateOpticalPath(path, source);
    return { channelId, flow, sources, power: result.powerDbm };
  }
  function at(ref: EndpointRef): MultiplexPoint | undefined {
    const port = graph.ports.get(signalPortKey(ref));
    const channels = port && channelsAt.get(port);
    if (!port || !channels) return;
    const prior = cached.get(port);
    if (prior) return prior;
    const waves: MultiplexWave[] = [];
    for (const flow of ['out', 'in'] as const) {
      for (const channel of channels) {
        const wave = readWave(ref, channel, flow);
        if (wave) waves.push(wave);
      }
    }
    const point = { ref, waves, in: total(waves.filter(w => w.flow === 'in')), out: total(waves.filter(w => w.flow === 'out')) };
    cached.set(port, point);
    return point;
  }
  const { showPath } = createPathNames(graph.instances);
  const label = (ref: EndpointRef) => showPath(ref.instancePath) + ' · ' + portDisplayName(graph.ports.get(signalPortKey(ref))!.definition);
  return { at, readWave, label };
}

export type MultiplexPower = ReturnType<typeof createMultiplexPower>;
