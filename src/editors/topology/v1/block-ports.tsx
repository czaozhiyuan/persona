import { resolveOpticalChannel } from '../../../model/v1/channels';
import type { PortLabelContext } from '../../../model/v1/display-names';
import type { MultiplexPoint } from '../../../engine/v1/multiplex-power';
import { portPowerLines } from '../../../workbench/v1/budgets/multiplex-details';
import { signalColor } from './signal-wire';
import { portDisplayName, portTypeLabels } from '../../../workbench/v1/labels';
import { Handle, Position } from '@xyflow/react';
import type { PortDefinition } from '../../../model/v1/types';

export const portSides = ['top', 'left', 'right'] as const;
const sideByDirection = { in: 'left', out: 'right', bidirectional: 'top' } as const;
export const boundaryPortSide = (port: PortDefinition) => sideByDirection[port.direction];

export type PortValue = (id: string) => MultiplexPoint | string | undefined;

export function PortLabel({ port, ports, open, value, labelContext, wdm }: { labelContext?: PortLabelContext; value?: ReturnType<PortValue>; port: PortDefinition; ports: readonly PortDefinition[]; open?: (id: string) => void; wdm?: boolean }) {
  const label = portDisplayName(port, false, ports, labelContext);
  const channel = wdm && port.channelIds?.[0] ? resolveOpticalChannel(port.channelIds[0]) : undefined;
  const text = channel ? channel.id.replace(/^(CWDM_|DWDM_)/, '') : wdm && port.id === 'COM' ? 'COM' : label;
  const detail = channel ? `${channel.id} / ${Number(channel.wavelengthNm.toFixed(2))} nm` : undefined;
  const lines = value && typeof value === 'object' ? portPowerLines(value, boundaryPortSide(port)) : undefined;
  const reading = lines && <small className="v1-port-multiplex">{(lines.length ? lines : ['无活动通道']).map(line => <span key={line}>{line}</span>)}</small>;
  const title = [label !== channel?.id && label, detail, typeof value === 'string' ? value : lines?.join(' / ')].filter(Boolean).join(' · ');
  return open ? <button type="button" className="v1-port-label nodrag nopan" title={title}
    aria-label={`操作端口 ${label}`} aria-haspopup="dialog"
    onClick={event => { event.stopPropagation(); open(port.id); }}
    onDoubleClick={event => event.stopPropagation()}>{text}{reading}</button> : <span>{text}{reading}</span>;
}

export function BlockPorts({ wdm, labelContext, portValue, ports, highlighted, newPortId, handleId, editable = false, wireState, openPort }: {
  wdm?: boolean;
  ports: readonly PortDefinition[];
  labelContext?: PortLabelContext;
  portValue?: PortValue;
  newPortId?: string;
  highlighted: ReadonlySet<string>;
  handleId: (id: string) => string;
  editable?: boolean;
  openPort?: (id: string) => void;
  wireState?: (id: string) => 'origin' | 'target' | undefined;
}) {
  function column(side: typeof portSides[number]) {
    return <div className={`v1-block-column ${side}`} key={side}>
      {ports.filter(port => boundaryPortSide(port) === side).map(port =>
        <div className={`v1-topology-port${highlighted.has(port.id) ? ' is-on-path' : ''}${port.id === newPortId ? ' is-new-port' : ''}`} key={port.id}
          title={`${portDisplayName(port, false, ports, labelContext)} · ${portTypeLabels[port.type]}`} data-port-direction={port.direction} data-wire={wireState?.(port.id)}>
          <Handle id={handleId(port.id)} type={port.direction === 'in' ? 'target' : 'source'}
            position={side === 'top' ? Position.Top : side === 'left' ? Position.Left : Position.Right} className={port.type} style={{ background: signalColor(port.type) }} isConnectable={editable} />
          <PortLabel wdm={wdm} labelContext={labelContext} value={portValue?.(port.id)} port={port} ports={ports} open={openPort} />
        </div>)}
    </div>;
  }
  return <>
    {ports.some(port => boundaryPortSide(port) === 'top') && column('top')}
    <div className="v1-block-columns">{column('left')}{column('right')}</div>
  </>;
}
