import type { PhysicalPlacement, Project } from '../../model/v1/types';

/** Change one physical occurrence while preserving the topology and all other placements. */
export function updatePhysicalPlacement(project: Project, placement: PhysicalPlacement): Project {
  const physical = project.layout?.physical ?? [];
  const key = JSON.stringify(placement.instancePath);
  const index = physical.findIndex(item => JSON.stringify(item.instancePath) === key);
  const next = [...physical];
  if (index < 0) next.push(placement);
  else next[index] = placement;
  return { ...project, layout: { ...project.layout, physical: next } };
}
