import type { RoutePoint as Point } from '../../../model/v1/types';

export type PortSide = 'left' | 'right' | 'top' | 'bottom';
export const wireCornerRadius = 8;
const normals = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };
export const outward = (side: PortSide) => normals[side];

export const towards = (a: Point, b: Point, n: number) => {
  const span = Math.hypot(b.x - a.x, b.y - a.y);
  return { x: a.x + (b.x - a.x) * n / span, y: a.y + (b.y - a.y) * n / span };
};

export function connectorControls(port: Point, side: PortSide, anchor: Point, next: Point) {
  const amount = Math.min(40, Math.hypot(port.x - anchor.x, port.y - anchor.y) / 3);
  const dir = outward(side);
  return [{ x: port.x + dir.x * amount, y: port.y + dir.y * amount }, towards(anchor, next, -amount)] as const;
}
