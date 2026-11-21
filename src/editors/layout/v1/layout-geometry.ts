import type { PhysicalFootprint, PhysicalPlacement } from '../../../model/v1/types';

export type LayoutPoint = { x: number; y: number };
export type LayoutBounds = { left: number; top: number; right: number; bottom: number };
export type PlacedObject = { placement: PhysicalPlacement; name: string; footprint?: PhysicalFootprint };
export const gridStepMm = 10;

export const normalizeRotation = (degrees: number) => (degrees % 360 + 360) % 360;

export function alignedPosition(point: LayoutPoint, snap: boolean): LayoutPoint {
  if (!snap) return point;
  return { x: Math.round(point.x / gridStepMm) * gridStepMm, y: Math.round(point.y / gridStepMm) * gridStepMm };
}

export function placementBounds(placement: PhysicalPlacement, footprint?: PhysicalFootprint): LayoutBounds {
  const { xMm, yMm } = placement;
  const turn = normalizeRotation(placement.rotationDeg) / 90;
  const { widthMm = 0, depthMm = 0 } = footprint ?? {};
  const dx = [widthMm, -depthMm, -widthMm, depthMm][turn];
  const dy = [depthMm, widthMm, -depthMm, -widthMm][turn];
  return {
    left: xMm + Math.min(0, dx), top: yMm + Math.min(0, dy),
    right: xMm + Math.max(0, dx), bottom: yMm + Math.max(0, dy),
  };
}

export type LayoutIssue =
  | { kind: 'outside'; object: PlacedObject }
  | { kind: 'overlap'; object: PlacedObject; other: PlacedObject };

export function inspectLayout(enclosure: PhysicalFootprint, objects: readonly PlacedObject[]): LayoutIssue[] {
  const known = objects.flatMap(object => object.footprint ? [{ object, bounds: placementBounds(object.placement, object.footprint) }] : []);
  const issues: LayoutIssue[] = [];
  known.forEach(({ object, bounds: a }, index) => {
    if (a.left < 0 || a.top < 0 || a.right > enclosure.widthMm || a.bottom > enclosure.depthMm) {
      issues.push({ kind: 'outside', object });
    }
    for (let other = index + 1; other < known.length; other++) {
      const b = known[other].bounds;
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
        issues.push({ kind: 'overlap', object, other: known[other].object });
      }
    }
  });
  return issues;
}
