import type { OpticalChannelId } from '../../model/v1/channels';
import type { OpticalSource } from '../../model/v1/topology';
import type { EndpointRef, PortFlow } from '../../model/v1/types';
import { addSourceCarrier, findOpticalSupply, selectOpticalSource } from './optical-supply';
import { searchSignalPath, type Carrier, type SignalPath } from './path-search';
import { opticalSourceFlow, signalPortKey, type SignalEdge, type SignalGraph, type SignalPort } from './signal-graph';

export const cochannelConflict = '同方向、同波长存在多路来源或重复汇入，超出光功率合成模型。';
type Origin = { source: OpticalSource; path: SignalPath; modulator?: { eo: SignalEdge; supply: SignalPath } };
type Origins = { paths: Origin[]; unresolved: EndpointRef[] };

export function createOpticalOrigins(graph: SignalGraph, trials: readonly OpticalSource[] = []) {
  const adjacent = new Map<SignalPort, SignalEdge[]>();
  const modulators: SignalEdge[] = [];
  const emitters = new Set([...graph.ports.values()].filter(p => p.definition.opticalEmitter));
  const selected = new Map<SignalPort, Carrier>();
  for (const trial of trials) {
    const port = graph.ports.get(signalPortKey(trial.endpoint));
    if (port) { emitters.add(port); addSourceCarrier(selected, port, trial.channelId); }
  }
  for (const edge of graph.edges) {
    let arcs = adjacent.get(edge.from);
    if (!arcs) adjacent.set(edge.from, arcs = []);
    arcs.push(edge);
    if (edge.supply) modulators.push(edge);
  }
  const cache = new Map<string, Origins>();
  return (target: SignalPort, channel: OpticalChannelId, flow: PortFlow): Origins => {
    const key = JSON.stringify([target.ref, channel, flow]);
    const cached = cache.get(key);
    if (cached) return cached;
    const paths: Origin[] = [], unresolved: EndpointRef[] = [];
    function trace(start: SignalPort, eo?: SignalEdge) {
      const carrier = eo?.channels.kind === 'enter' ? eo.channels.channelIds : undefined;
      const result = searchSignalPath({ starts: [start], startFlow: opticalSourceFlow, target, targetFlow: flow,
        targetCarrier: [channel], startCarriers: !eo && !start.definition.opticalEmitter ? selected : undefined,
        carrier, adjacent, opticalOnly: true });
      if (result.status === 'unreachable') return;
      if (result.status !== 'resolved') {
        if (eo) {
          const supply = findOpticalSupply(graph, adjacent, eo.supply!, carrier, selected);
          if (supply.status === 'unreachable' || supply.status === 'incompatible_source') return;
        }
        unresolved.push(start.ref);
        return;
      }
      const first = result.path.steps[0];
      if (!eo) {
        const source = selectOpticalSource(first, trials);
        if (source) paths.push({ source, path: result.path });
        else unresolved.push(start.ref);
        return;
      }
      const supply = findOpticalSupply(graph, adjacent, eo.supply!, first.channelIds, selected);
      if (supply.status === 'unreachable' || supply.status === 'incompatible_source') return;
      if (supply.status !== 'resolved') { unresolved.push(start.ref); return; }
      const source = selectOpticalSource(supply.path.steps[0], trials);
      if (source) paths.push({ source, path: result.path, modulator: { eo, supply: supply.path } });
      else unresolved.push(start.ref);
    }
    for (const start of emitters) trace(start);
    for (const eo of modulators) trace(eo.to, eo);
    const result = { paths, unresolved };
    cache.set(key, result);
    return result;
  };
}
