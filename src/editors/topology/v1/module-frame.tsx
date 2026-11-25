import type { PortLabelContext } from '../../../model/v1/display-names';
import { signalColor } from './signal-wire';
import { portDisplayName, portTypeLabels } from '../../../workbench/v1/labels';
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { isPowerPort } from '../../../model/v1/types';
import type { PortDefinition } from '../../../model/v1/types';
import { boundaryPortSide, PortLabel, portSides, type PortValue } from './block-ports';
import { DeviceIcon, type DeviceIconKey } from './device-icon';
export const framePortRow = 28;
export const frameHeader = 52;
export const framePadding = 28;
const framePortColumn = 64;

export type FramePortHeights = { side: number; top: number };

export function measureFramePorts(columns: readonly HTMLElement[]): FramePortHeights {
  // offsetHeight is in canvas units even when the viewport is zoomed.
  return {
    side: Math.max(0, ...columns.filter(column => !column.classList.contains('top')).map(column => column.offsetHeight)),
    top: columns.find(column => column.classList.contains('top'))?.offsetHeight ?? 0,
  };
}

export function frameInsets(ports: readonly PortDefinition[], measured?: FramePortHeights | number) {
  const onSide = (side: typeof portSides[number]) => ports.filter(port => boundaryPortSide(port) === side);
  const left = onSide('left'), right = onSide('right'), above = onSide('top');
  const sideWidth = (items: readonly PortDefinition[]) =>
    items.some(p => isPowerPort(p.type)) ? 86 : items.length ? framePortColumn : framePadding;
  const sideHeight = typeof measured === 'number' ? measured : measured?.side ?? 0;
  const topHeight = typeof measured === 'object' ? measured.top : 0;
  const top = frameHeader + (above.length ? Math.max(framePortRow, topHeight) : 0);
  return {
    left: sideWidth(left), right: sideWidth(right), top,
    minWidth: Math.max(360, above.length * framePortColumn + 2 * framePadding),
    height: top + Math.max(sideHeight, Math.max(left.length, right.length, 1) * framePortRow) + framePadding,
  };
}

export function ModuleFrame({ frameKey, insets, onPortHeight, labelContext, iconKey, metricTitle, portValue, id, width, height, name, ports, highlighted, newPortId, handleId, editable = false, outerHandles = false, selected = false, wireState, controls, openPort }: {
  frameKey: string;
  insets: ReturnType<typeof frameInsets>;
  onPortHeight: (key: string, heights: FramePortHeights) => void;
  iconKey: DeviceIconKey;
  id: string;
  width?: number;
  height?: number;
  name: string;
  ports: readonly PortDefinition[];
  labelContext?: PortLabelContext;
  metricTitle?: string;
  portValue?: PortValue;
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
  const updateInternals = useUpdateNodeInternals();
  const frame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const columns = Array.from(frame.current!.querySelectorAll<HTMLElement>('.v1-module-pins'));
    function measure() {
      onPortHeight(frameKey, measureFramePorts(columns));
      updateInternals(id);
    }
    measure();
    const observer = new ResizeObserver(measure);
    for (const column of columns) {
      for (const row of column.children) observer.observe(row);
    }
    return () => observer.disconnect();
  }, [id, frameKey, width, height, ports, outerHandles, onPortHeight, updateInternals]);

  return <div ref={frame} className={`v1-module-frame${selected ? ' is-selected' : ''}`}>
    <div className="v1-frame-title" style={insets.top > frameHeader ? { top: insets.top - frameHeader } : undefined}>
      <DeviceIcon iconKey={iconKey} />
      <strong title={metricTitle ?? name}>{name}</strong>
      {controls}
    </div>
    {portSides.map(side => (side !== 'top' || ports.some(p => boundaryPortSide(p) === 'top')) && <div key={side} className={`v1-module-pins ${side}`}
      style={side === 'top' ? undefined : { width: insets[side], top: insets.top }}>
      {ports.filter(port => boundaryPortSide(port) === side).map(port => {
        const input = port.direction === 'in';
        return <div key={port.id} className={`v1-topology-port${highlighted.has(port.id) ? ' is-on-path' : ''}${port.id === newPortId ? ' is-new-port' : ''}`}
          title={`${portDisplayName(port, false, ports, labelContext)} · ${portTypeLabels[port.type]}`} data-port-direction={port.direction}>
          <Handle id={handleId(port.id, true)} type={!isPowerPort(port.type) && port.direction === 'out' ? 'target' : 'source'}
            position={side === 'top' ? Position.Bottom : side === 'left' ? Position.Right : Position.Left} className={`${port.type} v1-frame-inner-handle`} style={{ background: signalColor(port.type) }} data-wire={wireState?.(port.id, true)}
            isConnectable={editable} />
          {outerHandles && <Handle id={handleId(port.id, false)} type={!isPowerPort(port.type) && input ? 'target' : 'source'}
            position={side === 'top' ? Position.Top : side === 'left' ? Position.Left : Position.Right} className={`${port.type} v1-frame-outer-handle`} style={{ background: signalColor(port.type) }} data-wire={wireState?.(port.id, false)}
            isConnectable={editable} />}
          <PortLabel labelContext={labelContext} value={portValue?.(port.id)} port={port} ports={ports} open={openPort} />
        </div>;
      })}
    </div>)}
  </div>;
}
