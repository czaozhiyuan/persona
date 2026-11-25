import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, useReactFlow } from '@xyflow/react';
import type { EdgeProps, XYPosition } from '@xyflow/react';
import type { PortType } from '../../../model/v1/types';
import type { WiringEdge } from './topology-wiring';

export const signalColor = (type: PortType) => `var(--v1-signal-${type})`;

function outward(position: Position) {
  switch (position) {
    case Position.Left: return { x: -1, y: 0 };
    case Position.Right: return { x: 1, y: 0 };
    case Position.Top: return { x: 0, y: -1 };
    case Position.Bottom: return { x: 0, y: 1 };
  }
}

function fannedCurve(edge: EdgeProps<WiringEdge>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = edge;
  const { x = 0, y = 0 } = data?.fan ?? {};
  const vertical = (side: Position) => side === Position.Top || side === Position.Bottom;
  if (!x && !y && !vertical(sourcePosition) && !vertical(targetPosition)) return getBezierPath(edge);

  // Fan in the axis perpendicular to each port's outward direction.
  function control(start: XYPosition, end: XYPosition, side: Position, fan: number) {
    const dir = outward(side);
    const distance = (end.x - start.x) * dir.x + (end.y - start.y) * dir.y;
    let reach = distance >= 0 ? distance / 2 : 6.25 * Math.sqrt(-distance);
    // Two top handles at the same height still need to clear their card borders.
    if (dir.y) reach = Math.max(reach, Math.min(48, Math.hypot(end.x - start.x, end.y - start.y) / 4));
    return { x: start.x + dir.x * reach + (dir.y ? fan : 0), y: start.y + dir.y * reach + (dir.x ? fan : 0) };
  }
  const start = { x: sourceX, y: sourceY }, end = { x: targetX, y: targetY };
  const a = control(start, end, sourcePosition, x), b = control(end, start, targetPosition, y);
  return [`M ${sourceX},${sourceY} C ${a.x},${a.y} ${b.x},${b.y} ${targetX},${targetY}`,
    (sourceX + targetX + 3 * (a.x + b.x)) / 8, (sourceY + targetY + 3 * (a.y + b.y)) / 8] as const;
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
  const source = outward(sourcePosition), target = outward(targetPosition);
  const sx = sourceX + source.x * a, sy = sourceY + source.y * a;
  const tx = targetX + target.x * b, ty = targetY + target.y * b;
  // Equal controls on either side of the waypoint give the two cubics a common tangent.
  return [`M ${sourceX},${sourceY} C ${sx},${sy} ${x - dx * scale},${y - dy * scale} ${x},${y} S ${tx},${ty} ${targetX},${targetY}`, x, y] as const;
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
            if (!drag.current) return;
            event.stopPropagation();
            if (event.key === 'Escape') { event.preventDefault(); cancel(); }
          }}
          onClick={event => event.stopPropagation()} />
        {saved && !preview && <button type="button" className="v1-wire-reset"
          onClick={event => { event.stopPropagation(); edge.data?.savePoint?.(); }}>恢复默认轨迹</button>}
      </div>
    </EdgeLabelRenderer>}
  </g>;
}
