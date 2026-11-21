import { portDisplayName, portTypeLabels } from '../../../workbench/v1/labels';
import { Handle, Position } from '@xyflow/react';
import type { PortDefinition } from '../../../model/v1/types';

export const portSides = ['left', 'right'] as const;
export const boundaryPortSide = (direction: PortDefinition['direction']) => direction === 'in' ? 'left' : 'right';
export const blockPortRows = (ports: readonly PortDefinition[]) => {
  const left = ports.filter(port => boundaryPortSide(port.direction) === 'left').length;
  return Math.max(left, ports.length - left);
};

export function PortLabel({ port, open }: { port: PortDefinition; open?: (id: string) => void }) {
  const label = portDisplayName(port);
  return open ? <button type="button" className="v1-port-label nodrag nopan" title={label}
    aria-label={`操作端口 ${label}`} aria-haspopup="dialog"
    onClick={event => { event.stopPropagation(); open(port.id); }}
    onDoubleClick={event => event.stopPropagation()}>{label}</button> : <span>{label}</span>;
}

export function BlockPorts({ ports, highlighted, newPortId, handleId, editable = false, wireState, openPort }: {
  ports: readonly PortDefinition[];
  newPortId?: string;
  highlighted: ReadonlySet<string>;
  handleId: (id: string) => string;
  editable?: boolean;
  openPort?: (id: string) => void;
  wireState?: (id: string) => 'origin' | 'target' | undefined;
}) {
  return <div className="v1-block-columns">
    {portSides.map(side => <div className={`v1-block-column ${side}`} key={side}>
      {ports.filter(port => boundaryPortSide(port.direction) === side).map(port =>
        <div className={`v1-topology-port${highlighted.has(port.id) ? ' is-on-path' : ''}${port.id === newPortId ? ' is-new-port' : ''}`} key={port.id}
          title={`${port.id} · ${portTypeLabels[port.type]}`} data-port-direction={port.direction} data-wire={wireState?.(port.id)}>
          <Handle id={handleId(port.id)} type={port.direction === 'in' ? 'target' : 'source'}
            position={side === 'left' ? Position.Left : Position.Right} className={port.type} isConnectable={editable} />
          <PortLabel port={port} open={openPort} />
        </div>)}
    </div>)}
  </div>;
}
