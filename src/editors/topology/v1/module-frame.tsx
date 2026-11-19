import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { useEffect } from 'react';
import type { PortDefinition } from '../../../model/v1/types';

export const boundaryPortSide = (direction: string) => direction === 'in' ? 'left' : 'right';
export const framePortRow = 28;
export const frameHeader = 52;
export const framePadding = 28;
export const framePortColumn = 134;

export function frameInsets(ports: readonly PortDefinition[]) {
  const inputs = ports.filter(port => boundaryPortSide(port.direction) === 'left').length;
  const outputs = ports.length - inputs;
  return {
    left: inputs ? framePortColumn : framePadding,
    right: outputs ? framePortColumn : framePadding,
    height: frameHeader + Math.max(inputs, outputs, 1) * framePortRow + framePadding,
  };
}

export function ModuleFrame({ id, name, ports, highlighted, handleId, editable = false, outerHandles = false, selected = false }: {
  id: string;
  name: string;
  ports: readonly PortDefinition[];
  highlighted: ReadonlySet<string>;
  handleId: (portId: string, inner: boolean) => string;
  editable?: boolean;
  outerHandles?: boolean;
  selected?: boolean;
}) {
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => updateInternals(id), [id, ports, outerHandles, updateInternals]);

  return <div className={`v1-module-frame${selected ? ' is-selected' : ''}`}>
    <strong title={name}>{name}</strong>
    {(['left', 'right'] as const).map(side => <div key={side} className={`v1-module-pins ${side}`}>
      {ports.filter(port => boundaryPortSide(port.direction) === side).map(port => {
        const input = port.direction === 'in';
        return <div key={port.id} className={`v1-topology-port${highlighted.has(port.id) ? ' is-on-path' : ''}`}
          title={`${port.id} · ${port.type}`}>
          <Handle id={handleId(port.id, true)} type={input ? 'source' : 'target'}
            position={input ? Position.Right : Position.Left} className={`${port.type} v1-frame-inner-handle`}
            isConnectable={editable} />
          {outerHandles && <Handle id={handleId(port.id, false)} type={input ? 'target' : 'source'}
            position={input ? Position.Left : Position.Right} className={`${port.type} v1-frame-outer-handle`}
            isConnectable={false} />}
          <span>{port.id}</span>
        </div>;
      })}
    </div>)}
  </div>;
}
