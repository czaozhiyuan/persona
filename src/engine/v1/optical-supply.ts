import { searchSignalPath } from './path-search';
import type { Carrier } from './path-search';
import type { SignalEdge, SignalGraph, SignalPort } from './signal-graph';

/** An explicit selection applies only to the supply branch it can reach. */
export function findOpticalSupply(graph: SignalGraph, adjacent: ReadonlyMap<SignalPort, readonly SignalEdge[]>,
  target: SignalPort, targetCarrier: Carrier, selected: ReadonlyMap<SignalPort, Carrier>) {
  const search = (starts: readonly SignalPort[], startCarriers?: ReadonlyMap<SignalPort, Carrier>) =>
    searchSignalPath({ starts, startCarriers, target, adjacent, carrier: undefined, targetCarrier, opticalOnly: true });
  if (selected.size) {
    const result = search([...selected.keys()], selected);
    if (result.status !== 'unreachable') return result;
  }
  return search([...graph.ports.values()].filter(port => port.definition.opticalEmitter && !selected.has(port)));
}
