import type { PortLabelContext } from '../../../model/v1/display-names';
import { signalColor } from './signal-wire';
import { portDisplayName, portTypeLabels } from '../../../workbench/v1/labels';
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { isPowerPort } from '../../../model/v1/types';
import type { PortDefinition } from '../../../model/v1/types';
import { boundaryPortSide, PortLabel, portSides } from './block-ports';
import { DeviceIcon, type DeviceIconKey } from './device-icon';
export const framePortRow = 28;
export const frameHeader = 52;
export const framePadding = 28;
const framePortColumn = 45;

export function frameInsets(ports: readonly PortDefinition[]) {
  const inputs = ports.filter(port => boundaryPortSide(port.direction) === 'left').length;
  const outputs = ports.length - inputs;
  return {
    left: ports.some(p => p.direction === 'in' && isPowerPort(p.type)) ? 86 : inputs ? framePortColumn : framePadding,
    right: ports.some(p => p.direction === 'out' && isPowerPort(p.type)) ? 86 : outputs ? framePortColumn : framePadding,
    height: frameHeader + Math.max(inputs, outputs, 1) * framePortRow + framePadding,
  };
}

export function ModuleFrame({ labelContext, iconKey, metricTitle, portValue, id, width, height, name, ports, highlighted, newPortId, handleId, editable = false, outerHandles = false, selected = false, wireState, controls, openPort }: {
  iconKey: DeviceIconKey;
  id: string;
  width?: number;
  height?: number;
  name: string;
  ports: readonly PortDefinition[];
  labelContext?: PortLabelContext;
  metricTitle?: string;
  portValue?: (id: string) => string | undefined;
  newPortId?: string;
  highlighted: ReadonlySet<string>;
  handleId: (portId: string, inner: boolean) => string;
  editable?: boolean;
  outerHandles?: boolean;
  selected?: boolean;
  wireState?: (id: string, inner: boolean) => 'origin' | 'target' | undefined;
  controls?: ReactNode;
  openPort?: (id: string) => void;
}) {
  const insets = frameInsets(ports);
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => updateInternals(id), [id, width, height, ports, outerHandles, updateInternals]);

  return <div className={`v1-module-frame${selected ? ' is-selected' : ''}`}>
    <div className="v1-frame-title">
      <DeviceIcon iconKey={iconKey} />
      <strong title={metricTitle ?? name}>{name}</strong>
      {controls}
    </div>
    {portSides.map(side => <div key={side} className={`v1-module-pins ${side}`} style={{ width: insets[side] }}>
      {ports.filter(port => boundaryPortSide(port.direction) === side).map(port => {
        const input = port.direction === 'in';
        return <div key={port.id} className={`v1-topology-port${highlighted.has(port.id) ? ' is-on-path' : ''}${port.id === newPortId ? ' is-new-port' : ''}`}
          title={`${portDisplayName(port, false, ports, labelContext)} · ${portTypeLabels[port.type]}`} data-port-direction={port.direction}>
          <Handle id={handleId(port.id, true)} type={input ? 'source' : 'target'}
            position={input ? Position.Right : Position.Left} className={`${port.type} v1-frame-inner-handle`} style={{ background: signalColor(port.type) }} data-wire={wireState?.(port.id, true)}
            isConnectable={editable} />
          {outerHandles && <Handle id={handleId(port.id, false)} type={input ? 'target' : 'source'}
            position={input ? Position.Left : Position.Right} className={`${port.type} v1-frame-outer-handle`} style={{ background: signalColor(port.type) }} data-wire={wireState?.(port.id, false)}
            isConnectable={editable} />}
          <PortLabel labelContext={labelContext} value={portValue?.(port.id)} port={port} ports={ports} open={openPort} />
        </div>;
      })}
    </div>)}
  </div>;
}
