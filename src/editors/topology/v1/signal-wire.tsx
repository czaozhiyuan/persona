import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, useReactFlow } from '@xyflow/react';
import type { EdgeProps, XYPosition } from '@xyflow/react';
import type { PortType } from '../../../model/v1/types';
import type { WiringEdge } from './topology-wiring';

export const signalColor = (type: PortType) => `var(--v1-signal-${type})`;

function fannedCurve(edge: EdgeProps<WiringEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = edge;
  const { x = 0, y = 0 } = data?.fan ?? {};
  if (!x && !y) return getBezierPath(edge);

  // Handles face left or right. Bend only the control points and keep the endpoints on the handles.
  const control = (start: number, end: number, side: Position) => {
    const direction = side === Position.Left ? -1 : 1;
    const distance = direction * (end - start);
    const reach = distance >= 0 ? distance / 2 : 6.25 * Math.sqrt(-distance);
    return start + direction * reach;
  };
  const sx = control(sourceX, targetX, sourcePosition);
  const tx = control(targetX, sourceX, targetPosition);
  return [`M ${sourceX},${sourceY} C ${sx},${sourceY + x} ${tx},${targetY + y} ${targetX},${targetY}`, (sourceX + targetX + 3 * (sx + tx)) / 8, (sourceY + targetY) / 2 + 3 * (x + y) / 8] as const;
}

export function curveThroughPoint(edge: Pick<EdgeProps<WiringEdge>, 'sourceX' | 'sourceY' | 'targetX' | 'targetY' | 'sourcePosition' | 'targetPosition'>,
  point: XYPosition) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } = edge;
  const { x, y } = point;
  const a = Math.hypot(x - sourceX, y - sourceY) / 3;
  const b = Math.hypot(targetX - x, targetY - y) / 3;
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const span = Math.hypot(dx, dy);
  const scale = span ? Math.min(a, b) / span : 0;
  const sx = sourceX + (sourcePosition === Position.Left ? -a : a);
  const tx = targetX + (targetPosition === Position.Left ? -b : b);
  // Equal controls on either side of the waypoint give the two cubics a common tangent.
  return [`M ${sourceX},${sourceY} C ${sx},${sourceY} ${x - dx * scale},${y - dy * scale} ${x},${y} S ${tx},${targetY} ${targetX},${targetY}`, x, y] as const;
}

export function SignalWire(edge: EdgeProps<WiringEdge>) {
  const { screenToFlowPosition } = useReactFlow();
  const [preview, setPreview] = useState<XYPosition>();
  const drag = useRef<{ id: number; start: XYPosition; point: XYPosition }>(undefined);
  const saved = edge.data?.routePoint;
  const active = (edge.selected && preview) || saved;
  function cancel() {
    drag.current = undefined;
    setPreview(undefined);
  }
  useEffect(() => { if (!edge.selected) cancel(); }, [edge.selected]);
  function moved(event: PointerEvent<HTMLButtonElement>) {
    const gesture = drag.current;
    if (gesture?.id !== event.pointerId) return;
    const at = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    return { x: gesture.point.x + (at.x - gesture.start.x), y: gesture.point.y + (at.y - gesture.start.y) };
  }
  const [path, labelX, labelY] = active ? curveThroughPoint(edge, active) : fannedCurve(edge);
  const dash = edge.data?.wire.kind === 'mapping' ? '6 4' : undefined;
  return <g className="v1-signal-wire" style={{ color: edge.data && signalColor(edge.data.portType) }} strokeDasharray={dash}>
    <path d={path} className="v1-wire-halo" />
    <path d={path} className="v1-wire-casing" />
    <BaseEdge id={edge.id} path={path} interactionWidth={8} className="v1-wire-main" style={{ stroke: 'currentColor' }} />
    {edge.data?.caption && <text x={labelX} y={labelY - (edge.selected ? 11 : 5)} className="v1-wire-caption" textAnchor="middle">{edge.data.caption}</text>}
    {edge.selected && <EdgeLabelRenderer>
      <div className="v1-wire-control nodrag nopan" style={{ left: labelX, top: labelY }}>
        <button type="button" className="v1-wire-point" aria-label="拖动调整连线轨迹" title="拖动调整连线轨迹"
          onPointerDown={event => {
            if (event.button !== 0 || !event.isPrimary) return;
            event.stopPropagation(); event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { id: event.pointerId, start: screenToFlowPosition({ x: event.clientX, y: event.clientY }), point: { x: labelX, y: labelY } };
          }}
          onPointerMove={event => {
            const point = moved(event);
            const start = drag.current?.point;
            if (point && start) setPreview(point.x === start.x && point.y === start.y ? undefined : point);
          }}
          onPointerUp={event => {
            const point = moved(event);
            const start = drag.current?.point;
            if (!point || !start) return;
            cancel();
            if (point.x !== start.x || point.y !== start.y) edge.data?.savePoint?.(point);
          }}
          onLostPointerCapture={cancel} onPointerCancel={cancel}
          onKeyDown={event => {
            if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); cancel(); }
          }}
          onClick={event => event.stopPropagation()} />
        {saved && !preview && <button type="button" className="v1-wire-reset"
          onClick={event => { event.stopPropagation(); edge.data?.savePoint?.(); }}>恢复默认轨迹</button>}
      </div>
    </EdgeLabelRenderer>}
  </g>;
}
