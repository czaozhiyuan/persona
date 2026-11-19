import type { ResolvedInstance } from '../../../engine/v1/hierarchy';
import type { InstancePath } from '../../../model/v1/types';

export const hierarchyKey = (path: InstancePath): string => JSON.stringify(path);
export const inHierarchy = (scope: InstancePath, path: InstancePath): boolean =>
  path.length >= scope.length && scope.every((id, index) => id === path[index]);

export function hierarchyChildren(instances: readonly ResolvedInstance[]) {
  const children = new Map<string, ResolvedInstance[]>();
  for (const item of instances) {
    if (!item.instancePath.length) continue;
    const key = hierarchyKey(item.instancePath.slice(0, -1));
    const siblings = children.get(key) ?? [];
    siblings.push(item);
    children.set(key, siblings);
  }
  return children;
}

export function displayDepth(instances: readonly ResolvedInstance[], scope: InstancePath): number {
  let depth = 1;
  for (const item of instances) {
    if (inHierarchy(scope, item.instancePath)) depth = Math.max(depth, item.instancePath.length - scope.length);
  }
  return depth;
}

const cardWidth = 202;
const gap = 28;

export function layoutHierarchy(instances: readonly ResolvedInstance[], scope: InstancePath, depth: number) {
  const visible = instances.filter(item => inHierarchy(scope, item.instancePath)
    && item.instancePath.length - scope.length <= depth);
  const children = hierarchyChildren(visible);
  const scopeKey = hierarchyKey(scope);
  const locations = new Map<string, { x: number; y: number }>();
  const sizes = new Map<string, { width: number; height: number; expanded: boolean }>();

  // Lay out descendants before their containers, with positions relative to the immediate parent.
  for (const item of [...visible].reverse()) {
    const key = hierarchyKey(item.instancePath);
    const ownHeight = 48 + item.definition.ports.length * 24;
    const nested = children.get(key) ?? [];
    const expanded = key !== scopeKey && nested.length > 0;
    let width = cardWidth;
    let height = ownHeight;
    if (expanded || key === scopeKey) {
      let y = key === scopeKey && !item.definition.ports.length ? gap : ownHeight + gap;
      for (let start = 0; start < nested.length; start += 2) {
        let x = gap;
        let rowHeight = 0;
        for (const child of nested.slice(start, start + 2)) {
          const childKey = hierarchyKey(child.instancePath);
          const size = sizes.get(childKey)!;
          locations.set(childKey, { x, y });
          x += size.width + gap;
          rowHeight = Math.max(rowHeight, size.height);
        }
        width = Math.max(width, x);
        y += rowHeight + gap;
      }
      if (expanded) height = y;
    }
    sizes.set(key, { width: key === scopeKey ? cardWidth : width, height, expanded });
  }
  return visible.filter(item => hierarchyKey(item.instancePath) !== scopeKey || item.definition.ports.length > 0)
    .map(item => {
      const key = hierarchyKey(item.instancePath);
      const parentKey = hierarchyKey(item.instancePath.slice(0, -1));
      return { item, key, parentKey: key === scopeKey || parentKey === scopeKey ? undefined : parentKey,
        position: locations.get(key) ?? { x: gap, y: gap / 2 }, ...sizes.get(key)! };
    });
}
