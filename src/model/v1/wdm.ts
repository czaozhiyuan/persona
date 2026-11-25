import { resolveOpticalChannel } from './channels';
import type { OpticalChannelId } from './channels';
import type { ComponentDefinition, PortDefinition, PortFlow } from './types';
import { requireValid } from './validation';

export function wdmPort(id: string, channel: OpticalChannelId, direction: PortFlow): PortDefinition {
  return { id, name: channel, type: 'OPTICAL', direction, channelIds: [channel] };
}

export function wdmTransfers(ports: readonly PortDefinition[]) {
  return ports.filter(port => port.id !== 'COM').map(port => ({
    kind: 'optical' as const,
    fromPortId: port.direction === 'in' ? port.id : 'COM',
    toPortId: port.direction === 'in' ? 'COM' : port.id,
    channelIds: port.channelIds,
    insertionLossDb: { kind: 'parameter' as const, parameterId: 'insertionLoss' },
  }));
}

export function withWdmPorts(definition: ComponentDefinition, ports: readonly PortDefinition[]): ComponentDefinition {
  return { ...definition, ports, transfers: wdmTransfers(ports) };
}

export function validateWdm(definition: ComponentDefinition) {
  const common = definition.ports.find(port => port.id === 'COM');
  requireValid(common?.type === 'OPTICAL' && common.direction === 'bidirectional' && common.side === 'top'
    && !common.channelIds && !common.opticalEmitter, 'WDM 需要一个顶部、双向的公共光口 COM。');
  requireValid(!definition.dcSupply && !definition.dcLoad && !definition.switchStates?.length, 'WDM 是无源器件。');
  const loss = definition.parameters?.find(parameter => parameter.id === 'insertionLoss');
  requireValid(loss?.kind === 'numeric' && loss.unit === 'dB' && loss.valueKind === 'fixed' && (loss.range?.min ?? -1) >= 0,
    'WDM 需要非负的统一通道插损（dB）。');
  const channels = new Set<string>();
  for (const port of definition.ports) {
    if (port.id === 'COM') continue;
    const id = port.channelIds?.[0];
    requireValid(port.type === 'OPTICAL' && port.direction !== 'bidirectional' && !port.side && !port.opticalEmitter
      && port.channelIds?.length === 1 && id && id !== 'MM850' && resolveOpticalChannel(id),
    'WDM 波长端口需要一个标准 CWDM 或 DWDM 通道及单向输入/输出方向。');
    requireValid(!channels.has(id), 'WDM 波长通道重复：' + id);
    channels.add(id);
  }
  const routes = definition.transfers ?? [];
  requireValid(routes.length === channels.size && wdmTransfers(definition.ports).every(expected => routes.some(route =>
    route.kind === 'optical' && route.fromPortId === expected.fromPortId && route.toPortId === expected.toPortId
    && route.channelIds?.length === 1 && route.channelIds[0] === expected.channelIds?.[0] && !route.gainDb
    && route.insertionLossDb?.kind === 'parameter' && route.insertionLossDb.parameterId === 'insertionLoss')),
  'WDM 的每个波长端口都必须按本机方向连接 COM，并使用统一通道插损。');
}
