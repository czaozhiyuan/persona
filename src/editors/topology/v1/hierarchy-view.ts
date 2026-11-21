import type { ResolvedInstance } from '../../../engine/v1/hierarchy';
import type { InstancePath } from '../../../model/v1/types';

export const hierarchyKey = (path: InstancePath): string => JSON.stringify(path);
export const inHierarchy = (scope: InstancePath, path: InstancePath): boolean =>
  path.length >= scope.length && scope.every((id, index) => id === path[index]);

export function sharedParent(paths: readonly InstancePath[]): InstancePath | undefined {
  if (!paths[0]?.length) return;
  const parent = paths[0].slice(0, -1);
  return paths.every(path => path.length === parent.length + 1 && inHierarchy(parent, path)) ? parent : undefined;
}

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

export function displayDepth(instances: readonly ResolvedInstance[], scope: InstancePath, expanded?: ReadonlySet<string>): number {
  let depth = 1;
  for (const { instancePath } of instances) {
    if (!inHierarchy(scope, instancePath)) continue;
    let length = scope.length + 1;
    while (length < instancePath.length && (!expanded || expanded.has(hierarchyKey(instancePath.slice(0, length))))) length++;
    depth = Math.max(depth, length - scope.length);
  }
  return depth;
}
