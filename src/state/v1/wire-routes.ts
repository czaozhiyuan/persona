import type { InstancePath, Project, RoutePoint, TopologyWireRoute, WireRef } from '../../model/v1/types';
import { wireEndpoints, wireRouteKey } from '../../model/v1/wire-route';

export function offsetRoute(route: TopologyWireRoute, delta: RoutePoint): TopologyWireRoute {
  const offset = (p: RoutePoint) => ({ x: p.x + delta.x, y: p.y + delta.y });
  return route.kind === 'orthogonal' ? { ...route, points: route.points.map(offset) } : { ...route, ...offset(route) };
}

/** Replace only successfully planned wires, preserving failed and out-of-scope routes. */
export function applyWireRoutes(project: Project, updates: readonly TopologyWireRoute[]): Project {
  const pending = new Map(updates.map(r => [wireRouteKey(r.modulePath, r.wire), r]));
  let changed = false;
  const routes = (project.layout?.topologyWireRoutes ?? []).map(old => {
    const key = wireRouteKey(old.modulePath, old.wire);
    const next = pending.get(key);
    if (!next) return old;
    pending.delete(key);
    if (old.kind === 'orthogonal' && next.kind === 'orthogonal' && old.points.length === next.points.length
      && old.points.every((p, i) => p.x === next.points[i].x && p.y === next.points[i].y)) return old;
    changed = true;
    return next;
  });
  return changed || pending.size ? { ...project, layout: { ...project.layout, topologyWireRoutes: [...routes, ...pending.values()] } } : project;
}

export function setWireRoute(project: Project, modulePath: InstancePath, wire: WireRef, point?: { x: number; y: number }): Project {
  const key = wireRouteKey(modulePath, wire);
  const routes = (project.layout?.topologyWireRoutes ?? []).filter(r => wireRouteKey(r.modulePath, r.wire) !== key);
  if (point) routes.push({ modulePath, wire, ...point });
  return { ...project, layout: { ...project.layout, topologyWireRoutes: routes.length ? routes : undefined } };
}

export function translateGroupRoutes(project: Project, paths: readonly InstancePath[], delta: { x: number; y: number }): Project {
  const routes = project.layout?.topologyWireRoutes;
  if (!paths.length || !routes?.length) return project;
  const parent = paths[0].slice(0, -1);
  const scope = JSON.stringify(parent);
  const owner = moduleLookup(project)(parent)!;
  const ids = new Set(paths.map(path => path.at(-1)));
  const moved = routes.map(route => {
    if (route.kind === 'orthogonal' || JSON.stringify(route.modulePath) !== scope || route.wire.kind === 'mapping') return route;
    const ends = wireEndpoints(owner, route.wire);
    return ends && ids.has(ends[0]) && ids.has(ends[2])
      ? { ...route, x: route.x + delta.x, y: route.y + delta.y } : route;
  });
  return { ...project, layout: { ...project.layout, topologyWireRoutes: moved } };
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
