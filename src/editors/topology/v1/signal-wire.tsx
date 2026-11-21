import { BaseEdge, getBezierPath, Position } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { PortType } from '../../../model/v1/types';
import type { WiringEdge } from './topology-wiring';

export const signalColor = (type: PortType) => `var(--v1-signal-${type})`;

function fannedCurve(edge: EdgeProps<WiringEdge>): string {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = edge;
  const { x = 0, y = 0 } = data?.fan ?? {};
  if (!x && !y) return getBezierPath(edge)[0];

  // Handles face left or right. Bend only the control points and keep the endpoints on the handles.
  const control = (start: number, end: number, side: Position) => {
    const direction = side === Position.Left ? -1 : 1;
    const distance = direction * (end - start);
    const reach = distance >= 0 ? distance / 2 : 6.25 * Math.sqrt(-distance);
    return start + direction * reach;
  };
  const sx = control(sourceX, targetX, sourcePosition);
  const tx = control(targetX, sourceX, targetPosition);
  return `M ${sourceX},${sourceY} C ${sx},${sourceY + x} ${tx},${targetY + y} ${targetX},${targetY}`;
}

export function SignalWire(edge: EdgeProps<WiringEdge>) {
  const path = fannedCurve(edge);
  const dash = edge.data?.kind === 'mapping' ? '6 4' : undefined;
  return <g className="v1-signal-wire" style={{ color: edge.data && signalColor(edge.data.portType) }} strokeDasharray={dash}>
    <path d={path} className="v1-wire-halo" />
    <path d={path} className="v1-wire-casing" />
    <BaseEdge id={edge.id} path={path} interactionWidth={8} className="v1-wire-main" style={{ stroke: 'currentColor' }} />
  </g>;
}
