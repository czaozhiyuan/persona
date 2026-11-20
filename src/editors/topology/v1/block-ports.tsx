import { portDisplayName, portTypeLabels } from '../../../workbench/v1/labels';
import { Handle, Position } from '@xyflow/react';
import type { PortDefinition } from '../../../model/v1/types';

export const portSides = ['left', 'right'] as const;
export const boundaryPortSide = (direction: PortDefinition['direction']) => direction === 'in' ? 'left' : 'right';
export const blockPortRows = (ports: readonly PortDefinition[]) => {
  const left = ports.filter(port => boundaryPortSide(port.direction) === 'left').length;
  return Math.max(left, ports.length - left);
};

export function BlockPorts({ ports, highlighted, handleId, editable = false }: {
  ports: readonly PortDefinition[];
  highlighted: ReadonlySet<string>;
  handleId: (id: string) => string;
  editable?: boolean;
}) {
  return <div className="v1-block-columns">
    {portSides.map(side => <div className={`v1-block-column ${side}`} key={side}>
      {ports.filter(port => boundaryPortSide(port.direction) === side).map(port =>
        <div className={`v1-topology-port${highlighted.has(port.id) ? ' is-on-path' : ''}`} key={port.id}
          title={`${port.id} · ${portTypeLabels[port.type]}`} data-port-direction={port.direction}>
          <Handle id={handleId(port.id)} type={port.direction === 'in' ? 'target' : 'source'}
            position={side === 'left' ? Position.Left : Position.Right} className={port.type} isConnectable={editable} />
          <span>{portDisplayName(port.id)}</span>
        </div>)}
    </div>)}
  </div>;
}
