import type { InstancePath } from '../../model/v1/types';

/** Keep each outermost occurrence once, in selection order. */
export function outermostPaths(paths: readonly InstancePath[]): InstancePath[] {
  const unique = new Map(paths.map(path => [JSON.stringify(path), path]));
  return [...unique.values()].filter(path =>
    !path.some((_, depth) => depth > 0 && unique.has(JSON.stringify(path.slice(0, depth)))));
}
