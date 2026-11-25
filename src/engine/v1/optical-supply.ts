import type { OpticalChannelId } from '../../model/v1/channels';
import type { OpticalSource } from '../../model/v1/topology';
import { searchSignalPath } from './path-search';
import type { Carrier, SignalStep } from './path-search';
import { opticalSourceFlow, signalPortKey } from './signal-graph';
import type { SignalEdge, SignalGraph, SignalPort } from './signal-graph';

export const cascadedModulation = '不支持直调激光器再接外置调制器的串联调制。';
export const incompatibleSource = '所选光源与此调制器输入端口的通道不兼容，请选择兼容通道或其他光源。';

export function addSourceCarrier(selected: Map<SignalPort, Carrier>, port: SignalPort, channelId?: OpticalChannelId) {
  if (channelId === undefined || (selected.has(port) && selected.get(port) === undefined)) selected.set(port, undefined);
  else selected.set(port, [...new Set([...(selected.get(port) ?? []), channelId])]);
}

/** A unique path fixes the source endpoint even when its wavelength is unrestricted. */
export function selectOpticalSource(first: SignalStep, sources: readonly OpticalSource[]): OpticalSource | undefined {
  const key = signalPortKey(first.port.ref);
  const candidates = sources.filter(source => signalPortKey(source.endpoint) === key
    && (!source.channelId || !first.channelIds || first.channelIds.includes(source.channelId)));
  if (candidates.length > 1) return;
  const channelId = first.channelIds?.length === 1 ? first.channelIds[0] : candidates[0]?.channelId;
  return { ...candidates[0], endpoint: first.port.ref, channelId };
}

/** An explicit selection applies only to the supply branch it can reach. */
export function findOpticalSupply(graph: SignalGraph, adjacent: ReadonlyMap<SignalPort, readonly SignalEdge[]>,
  target: SignalPort, targetCarrier: Carrier, selected: ReadonlyMap<SignalPort, Carrier>) {
  const search = (starts: readonly SignalPort[], startCarriers?: ReadonlyMap<SignalPort, Carrier>, ignoreChannels = false) =>
    searchSignalPath({ starts, startCarriers, startFlow: opticalSourceFlow, target, targetFlow: 'in',
      adjacent, carrier: undefined, targetCarrier: ignoreChannels ? undefined : targetCarrier, opticalOnly: true, ignoreChannels });
  const dmlOutputs = graph.edges.filter(edge => edge.source.kind === 'transfer' && edge.source.transfer.kind === 'dml').map(edge => edge.to);
  if (dmlOutputs.length) {
    const cascade = search(dmlOutputs);
    if (cascade.status === 'resolved' || cascade.status === 'ambiguous') return { status: 'cascaded_modulation' } as const;
  }
  if (selected.size) {
    const result = search([...selected.keys()], selected);
    if (result.status !== 'unreachable') return result;
    // Ignore wavelengths only to establish which supply branch owns the selection.
    const connected = search([...selected.keys()], undefined, true);
    if (connected.status === 'search_limit') return connected;
    if (connected.status !== 'unreachable') return { status: 'incompatible_source' } as const;
  }
  return search([...graph.ports.values()].filter(port => port.definition.opticalEmitter && !selected.has(port)));
}
