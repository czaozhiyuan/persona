import { searchSignalPath } from './path-search';
import type { Carrier } from './path-search';
import type { SignalEdge, SignalGraph, SignalPort } from './signal-graph';

export const cascadedModulation = '不支持直调激光器再接外置调制器的串联调制。';

/** An explicit selection applies only to the supply branch it can reach. */
export function findOpticalSupply(graph: SignalGraph, adjacent: ReadonlyMap<SignalPort, readonly SignalEdge[]>,
  target: SignalPort, targetCarrier: Carrier, selected: ReadonlyMap<SignalPort, Carrier>) {
  const search = (starts: readonly SignalPort[], startCarriers?: ReadonlyMap<SignalPort, Carrier>) =>
    searchSignalPath({ starts, startCarriers, target, adjacent, carrier: undefined, targetCarrier, opticalOnly: true });
  const dmlOutputs = graph.edges.filter(edge => edge.source.kind === 'transfer' && edge.source.transfer.kind === 'dml').map(edge => edge.to);
  if (dmlOutputs.length) {
    const cascade = search(dmlOutputs);
    if (cascade.status === 'resolved' || cascade.status === 'ambiguous') return { status: 'cascaded_modulation' } as const;
  }
  if (selected.size) {
    const result = search([...selected.keys()], selected);
    if (result.status !== 'unreachable') return result;
  }
  return search([...graph.ports.values()].filter(port => port.definition.opticalEmitter && !selected.has(port)));
}
