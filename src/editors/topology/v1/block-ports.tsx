import type { PortLabelContext } from '../../../model/v1/display-names';
import { signalColor } from './signal-wire';
import { portDisplayName, portTypeLabels } from '../../../workbench/v1/labels';
import { Handle, Position } from '@xyflow/react';
import type { PortDefinition } from '../../../model/v1/types';

export const portSides = ['top', 'left', 'right'] as const;
const sideByDirection = { in: 'left', out: 'right', bidirectional: 'top' } as const;
export const boundaryPortSide = (port: PortDefinition) => sideByDirection[port.direction];

export function PortLabel({ port, ports, open, value, labelContext }: { labelContext?: PortLabelContext; value?: string; port: PortDefinition; ports: readonly PortDefinition[]; open?: (id: string) => void }) {
  const label = portDisplayName(port, false, ports, labelContext);
  return open ? <button type="button" className="v1-port-label nodrag nopan" title={value ? label + ' · ' + value : label}
    aria-label={`操作端口 ${label}`} aria-haspopup="dialog"
    onClick={event => { event.stopPropagation(); open(port.id); }}
    onDoubleClick={event => event.stopPropagation()}>{label}{value?.startsWith('复用光 ') && <small className="v1-port-multiplex">{value}</small>}</button> : <span>{label}</span>;
}

export function BlockPorts({ labelContext, portValue, ports, highlighted, newPortId, handleId, editable = false, wireState, openPort }: {
  ports: readonly PortDefinition[];
  labelContext?: PortLabelContext;
  portValue?: (id: string) => string | undefined;
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
          <PortLabel labelContext={labelContext} value={portValue?.(port.id)} port={port} ports={ports} open={openPort} />
        </div>)}
    </div>;
  }
  return <>
    {ports.some(port => boundaryPortSide(port) === 'top') && column('top')}
    <div className="v1-block-columns">{column('left')}{column('right')}</div>
  </>;
}
