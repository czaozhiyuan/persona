import type { InstancePath, Project, TopologyWireRoute, WireRef } from '../../model/v1/types';
import { wireEndpoints, wireRouteKey } from '../../model/v1/wire-route';

export function setWireRoute(project: Project, modulePath: InstancePath, wire: WireRef, point?: { x: number; y: number }): Project {
  const key = wireRouteKey(modulePath, wire);
  const routes = (project.layout?.topologyWireRoutes ?? []).filter(r => wireRouteKey(r.modulePath, r.wire) !== key);
  if (point) routes.push({ modulePath, wire, ...point });
  return { ...project, layout: { ...project.layout, topologyWireRoutes: routes.length ? routes : undefined } };
}

function moduleLookup(project: Project) {
  const modules = new Map(project.moduleDefinitions.map(m => [m.id, m]));
  return (path: InstancePath) => {
    let module = modules.get(project.rootModuleDefinitionId);
    for (const id of path) {
      const slot = module?.instances.find(child => child.id === id);
      if (!slot) return;
      module = modules.get(slot.definitionId);
    }
    return module;
  };
}

export function retainWireRoutes(before: Project, after: Project, remap?: (path: InstancePath) => InstancePath): Project {
  const routes = before.layout?.topologyWireRoutes;
  if (!routes?.length) return after;
  const oldTree = moduleLookup(before);
  const newTree = moduleLookup(after);
  const kept: TopologyWireRoute[] = [];
  for (const route of routes) {
    const modulePath = remap ? remap(route.modulePath) : route.modulePath;
    const oldOwner = oldTree(route.modulePath);
    const newOwner = newTree(modulePath);
    if (!oldOwner || !newOwner || oldOwner.id !== newOwner.id) continue;
    const oldEnds = wireEndpoints(oldOwner, route.wire);
    const newEnds = wireEndpoints(newOwner, route.wire);
    if (oldEnds && newEnds && oldEnds.every((id, i) => id === newEnds[i])) kept.push({ ...route, modulePath });
  }
  return { ...after, layout: { ...after.layout, topologyWireRoutes: kept.length ? kept : undefined } };
}
