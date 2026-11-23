import type { ResolvedInstance } from '../../engine/v1/hierarchy';
import type { InstancePath } from '../../model/v1/types';
import { createPathNames } from '../../engine/v1/path-names';
export { createPathNames };

export function structureScope(instances: readonly ResolvedInstance[], definitionId: string): readonly string[] {
  const paths = instances.filter(item => item.definition.id === definitionId).map(item => item.instancePath);
  return paths.length < 2 ? [] : structureLocations(instances, paths);
}

export function structureLocations(instances: readonly ResolvedInstance[], paths: readonly InstancePath[]): readonly string[] {
  return paths.map(createPathNames(instances).showPath);
}
