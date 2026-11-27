import type { XYPosition } from '@xyflow/react';

export const topologyGrid = 10;

export function gridCoordinate(value: number, free = false, min = -Infinity, max = Infinity) {
  const first = Math.ceil(min / topologyGrid);
  const last = Math.floor(max / topologyGrid);
  if (free || first > last) return Math.max(min, Math.min(max, value));
  return Math.max(first, Math.min(last, Math.round(value / topologyGrid))) * topologyGrid || 0;
}

export function gridPoint(point: XYPosition, free = false): XYPosition {
  return { x: gridCoordinate(point.x, free), y: gridCoordinate(point.y, free) };
}
