import { portTypeLabels } from '../../../workbench/v1/labels';
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import type { PortDefinition } from '../../../model/v1/types';
import { boundaryPortSide, PortLabel, portSides } from './block-ports';
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

export function ModuleFrame({ id, name, ports, highlighted, handleId, editable = false, outerHandles = false, selected = false, wireState, controls, openPort }: {
  id: string;
  name: string;
  ports: readonly PortDefinition[];
  highlighted: ReadonlySet<string>;
  handleId: (portId: string, inner: boolean) => string;
  editable?: boolean;
  outerHandles?: boolean;
  selected?: boolean;
  wireState?: (id: string, inner: boolean) => 'origin' | 'target' | undefined;
  controls?: ReactNode;
  openPort?: (id: string) => void;
}) {
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => updateInternals(id), [id, ports, outerHandles, updateInternals]);

  return <div className={`v1-module-frame${selected ? ' is-selected' : ''}`}>
    <div className="v1-frame-title">
      <strong title={name}>{name}</strong>
      {controls}
    </div>
    {portSides.map(side => <div key={side} className={`v1-module-pins ${side}`}>
      {ports.filter(port => boundaryPortSide(port.direction) === side).map(port => {
        const input = port.direction === 'in';
        return <div key={port.id} className={`v1-topology-port${highlighted.has(port.id) ? ' is-on-path' : ''}`}
          title={`${port.id} · ${portTypeLabels[port.type]}`} data-port-direction={port.direction}>
          <Handle id={handleId(port.id, true)} type={input ? 'source' : 'target'}
            position={input ? Position.Right : Position.Left} className={`${port.type} v1-frame-inner-handle`} data-wire={wireState?.(port.id, true)}
            isConnectable={editable} />
          {outerHandles && <Handle id={handleId(port.id, false)} type={input ? 'target' : 'source'}
            position={input ? Position.Left : Position.Right} className={`${port.type} v1-frame-outer-handle`} data-wire={wireState?.(port.id, false)}
            isConnectable={editable} />}
          <PortLabel port={port} open={openPort} />
        </div>;
      })}
    </div>)}
  </div>;
}
