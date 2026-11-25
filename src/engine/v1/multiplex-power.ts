import type { OpticalChannelId } from '../../model/v1/channels';
import { portDisplayName } from '../../model/v1/display-names';
import type { EndpointRef, PortFlow } from '../../model/v1/types';
import { wireRouteKey } from '../../model/v1/wire-route';
import { addGain, budgetValue, logZero, unavailable, type BudgetMetric } from './budget-metric';
import { createOpticalBudgetForGraph } from './optical-budget';
import { createPathNames } from './path-names';
import { cochannelConflict, createOpticalOrigins } from './optical-origins';
import type { OpticalSource } from '../../model/v1/topology';
import { portFlowAt, signalPortKey, type SignalEdge, type SignalGraph, type SignalPort } from './signal-graph';

export type MultiplexWave = {
  channelId: OpticalChannelId;
  flow: PortFlow;
  sources: readonly EndpointRef[];
  power: BudgetMetric<'dBm'>;
};
export type MultiplexTotal = { known: BudgetMetric<'dBm'>; partial: boolean };
export type MultiplexPoint = { ref: EndpointRef; waves: MultiplexWave[]; in: MultiplexTotal; out: MultiplexTotal };
export type MultiplexDirection = {
  from: EndpointRef; to: EndpointRef; fromFlow: PortFlow; toFlow: PortFlow;
  start: MultiplexTotal; arrival: MultiplexTotal; lossDb: number;
  waves: (MultiplexWave & { arrival: BudgetMetric<'dBm'> })[];
};

function physicalWireKey({ source }: SignalEdge) {
  if (source.kind === 'connection') return wireRouteKey(source.ref.scopePath, { kind: 'connection', id: source.ref.connectionId });
  if (source.kind === 'cableCore') return wireRouteKey(source.ref.scopePath, { kind: 'core', bundleId: source.ref.bundleId, id: source.ref.coreId });
  if (source.kind === 'portMapping') return wireRouteKey(source.publicPort.instancePath, { kind: 'mapping', id: source.publicPort.portId });
}

function total(powers: readonly BudgetMetric<'dBm'>[]): MultiplexTotal {
  const values = powers.flatMap(p => p.availability === 'available' ? [p.value] : []);
  const partial = values.length < powers.length;
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
    const sum = (flow: PortFlow) => total(waves.flatMap(w => w.flow === flow ? [w.power] : []));
    const point = { ref, waves, in: sum('in'), out: sum('out') };
    cached.set(port, point);
    return point;
  }
  const arcs = new Map<string, SignalEdge[]>();
  for (const edge of graph.edges) {
    if (!channelsAt.has(edge.from) || !channelsAt.has(edge.to)) continue;
    const key = physicalWireKey(edge);
    if (!key) continue;
    const directions = arcs.get(key);
    if (directions) directions.push(edge);
    else arcs.set(key, [edge]);
  }
  const wires = new Map<string, MultiplexDirection[]>();
  function wire(key: string) {
    const edges = arcs.get(key);
    if (!edges) return;
    const cachedWire = wires.get(key);
    if (cachedWire) return cachedWire;
    const directions: MultiplexDirection[] = [];
    for (const edge of edges) {
      const { from, to, source, channels } = edge;
      if (channels.kind !== 'preserve') continue;
      const fromFlow = portFlowAt(edge, from), toFlow = portFlowAt(edge, to);
      const lossDb = (source.kind === 'connection' || source.kind === 'cableCore' ? source.lossDb : undefined) ?? 0;
      // A receiver can have other incoming wires. Propagate only waves admitted by this arc.
      const gain = budgetValue('dB', -lossDb);
      const waves = at(from.ref)!.waves.filter(w => w.flow === fromFlow && (!channels.channelIds || channels.channelIds.includes(w.channelId)))
        .map(w => ({ ...w, arrival: addGain(w.power, gain) }));
      if (waves.length) directions.push({ from: from.ref, to: to.ref, fromFlow, toFlow, lossDb, waves,
        start: total(waves.map(w => w.power)), arrival: total(waves.map(w => w.arrival)) });
    }
    wires.set(key, directions);
    return directions;
  }
  const { showPath } = createPathNames(graph.instances);
  const label = (ref: EndpointRef) => showPath(ref.instancePath) + ' · ' + portDisplayName(graph.ports.get(signalPortKey(ref))!.definition);
  return { at, readWave, wire, label };
}

export type MultiplexPower = ReturnType<typeof createMultiplexPower>;
