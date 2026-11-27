import { retainWireRoutes } from './wire-routes';
import { resolveHierarchy } from '../../engine/v1/hierarchy';
import type { InstancePath, Project, TopologyPlacement, TopologyWireRoute } from '../../model/v1/types';
import { validateProjectSnapshot } from '../../storage/v1/project-json';
import { remapLinkReferences } from './remap-link-references';
import { moveLocalWiring, transferMoveParameters, type ModuleHop } from './reparent-wiring';

type OccurrenceMove = { from: InstancePath; to: InstancePath };
type MoveOptions = { position?: Pick<TopologyPlacement, 'x' | 'y'> };
type MovePlan =
  | { ok: true; project: Project; instancePath: InstancePath; instancePaths: readonly InstancePath[];
      affected: readonly OccurrenceMove[]; fixedRoutesToPlace: readonly TopologyWireRoute[]; wiring: { retained: number; disconnected: number } }
  | { ok: false; message: string };

const key = (path: InstancePath) => JSON.stringify(path);
const samePath = (a: InstancePath, b: InstancePath) => key(a) === key(b);
const startsWith = (path: InstancePath, prefix: InstancePath) =>
  path.length >= prefix.length && prefix.every((id, index) => path[index] === id);

export function moveWiringSummary({ retained, disconnected }: Extract<MovePlan, { ok: true }>['wiring']) {
  return `随移保留 ${retained} 条连线，断开 ${disconnected} 条（含纤芯）`;
}

function applyMove(project: Project, sources: readonly InstancePath[], destination: InstancePath, options: MoveOptions) {
  const source = sources[0];
  if (!source) throw new Error('请至少选择一个待移动实例。');
  if (sources.some(path => !path.length)) throw new Error('根模块不能移动。');
  const fromParent = source.slice(0, -1);
  if (sources.some(path => !samePath(path.slice(0, -1), fromParent))) {
    throw new Error('同时移动的实例必须来自同一直接父模块。');
  }
  const moving = new Set(sources.map(path => path.at(-1)!));
  if (moving.size !== sources.length) throw new Error('待移动的实例不能重复。');
  if (sources.some(path => startsWith(destination, path))) throw new Error('不能将实例移入自身或其后代。');
  if (samePath(fromParent, destination)) throw new Error('实例已在目标模块内。');

  const hierarchy = resolveHierarchy(project);
  const from = hierarchy.resolveInstance(fromParent)?.definition;
  const to = hierarchy.resolveInstance(destination)?.definition;
  if (from?.kind !== 'module' || to?.kind !== 'module') throw new Error('源或目标模块已不存在。');
  let commonDepth = 0;
  while (commonDepth < Math.min(fromParent.length, destination.length)
    && fromParent[commonDepth] === destination[commonDepth]) commonDepth++;
  const common = hierarchy.resolveInstance(fromParent.slice(0, commonDepth))!.definition;
  const modules = new Map(project.moduleDefinitions.map(module => [module.id, module]));

  function branch(path: InstancePath): ModuleHop[] {
    let parent = modules.get(common.id)!;
    return path.slice(commonDepth).map(id => {
      const slot = parent.instances.find(instance => instance.id === id)!;
      const child = modules.get(slot.definitionId)!;
      // Each occurrence below the common ancestor must have exactly one matching source and destination.
      for (const module of project.moduleDefinitions) {
        const other = module.instances.find(instance => instance.definitionId === child.id
          && (module.id !== parent.id || instance.id !== slot.id));
        if (other) throw new Error(`模块定义「${child.name}」另被「${module.name} / ${other.name}」使用，无法逐一保留移动对象的出现位置。`);
      }
      const hop = { parentId: parent.id, childId: child.id, slot };
      parent = child;
      return hop;
    });
  }
  const sourceBranch = branch(fromParent), targetBranch = branch(destination);
  const moved = from.instances.filter(instance => moving.has(instance.id));
  if (moved.length !== moving.size) throw new Error('待移动的实例已不存在。');
  const conflict = to.instances.find(instance => moving.has(instance.id));
  if (conflict) throw new Error(`目标模块「${to.name}」已有实例「${conflict.name}」，与移动对象的内部引用冲突。`);

  const sourceScopes = new Map<string, InstancePath>();
  const affected: OccurrenceMove[] = [];
  for (const item of hierarchy.walkInstances()) {
    if (item.definition.id !== common.id) continue;
    const oldScope = [...item.instancePath, ...fromParent.slice(commonDepth)];
    const newScope = [...item.instancePath, ...destination.slice(commonDepth)];
    sourceScopes.set(key(oldScope), newScope);
    for (const id of moving) affected.push({ from: [...oldScope, id], to: [...newScope, id] });
  }

  transferMoveParameters(modules, from.id, to.id, moving, sourceBranch, targetBranch, (hop, id) =>
    Object.hasOwn(hop.slot.parameterOverrides ?? {}, id) || !!project.instanceSettings?.some(setting =>
      Object.hasOwn(setting.parameterOverrides ?? {}, id) && hierarchy.resolveInstance(setting.instancePath)?.definition.id === hop.childId));
  const wiring = moveLocalWiring(modules.get(from.id)!, modules.get(to.id)!, moving);
  modules.set(from.id, { ...wiring.source, instances: from.instances.filter(item => !moving.has(item.id)) });
  modules.set(to.id, { ...wiring.destination, instances: [...to.instances, ...moved] });

  const destinations = new Map(affected.map(move => [key(move.from), move.to]));
  function remap(path: InstancePath): InstancePath {
    for (let length = 1; length <= path.length; length++) {
      const target = destinations.get(key(path.slice(0, length)));
      if (target) return [...target, ...path.slice(length)];
    }
    return path;
  }

  function atInstance<T extends { instancePath: InstancePath }>(record: T): T {
    return { ...record, instancePath: remap(record.instancePath) };
  }

  const instancePaths = sources.map(remap);
  const instancePath = instancePaths[0];
  const layout = project.layout;
  const topology = layout?.topology?.map(atInstance);
  const position = options.position;
  let candidate = retainWireRoutes(project, {
    ...project,
    moduleDefinitions: [...modules.values()],
    instanceSettings: project.instanceSettings?.map(atInstance),
    namedLinks: project.namedLinks?.map(link => remapLinkReferences(link, remap, atInstance, ref => {
      const destinationScope = sourceScopes.get(key(ref.scopePath));
      if (destinationScope) {
        if ('connectionId' in ref) {
          const connectionId = wiring.relocatedConnections.get(ref.connectionId);
          if (connectionId !== undefined) return { scopePath: destinationScope, connectionId };
          if (wiring.deletedConnections.has(ref.connectionId)) return undefined;
        } else {
          const bundleId = wiring.relocatedBundles.get(ref.bundleId);
          if (bundleId !== undefined) return { ...ref, scopePath: destinationScope, bundleId };
          if (wiring.disconnectedCores.get(ref.bundleId)?.has(ref.coreId)) return undefined;
        }
      }
      return { ...ref, scopePath: remap(ref.scopePath) };
    })),
    layout: (layout || position) && {
      ...layout,
      topology: position ? [
        ...(topology ?? []).filter(item => !samePath(item.instancePath, instancePath)),
        { instancePath, x: position.x, y: position.y },
      ] : topology,
      topologyFrames: layout?.topologyFrames?.map(frame => ({ ...frame, modulePath: remap(frame.modulePath) })),
      physical: layout?.physical?.map(placement => ({
        ...atInstance(placement), enclosurePath: remap(placement.enclosurePath),
      })),
    },
  }, remap);
  const relocated: TopologyWireRoute[] = [];
  const fixedRoutesToPlace: TopologyWireRoute[] = [];
  for (const route of layout?.topologyWireRoutes ?? []) {
    const modulePath = sourceScopes.get(key(route.modulePath));
    if (!modulePath) continue;
    // Only the dragged occurrence has a measured transform into its destination.
    if (route.kind === 'orthogonal' && !samePath(modulePath, destination)) continue;
    const mapped = route.kind === 'orthogonal' ? fixedRoutesToPlace : relocated;
    const wire = route.wire;
    if (wire.kind === 'connection') {
      const id = wiring.relocatedConnections.get(wire.id);
      if (id !== undefined) mapped.push({ ...route, modulePath, wire: { ...wire, id } });
    } else if (wire.kind === 'core') {
      const bundleId = wiring.relocatedBundles.get(wire.bundleId);
      if (bundleId !== undefined) mapped.push({ ...route, modulePath, wire: { ...wire, bundleId } });
    }
  }
  if (relocated.length) candidate = { ...candidate, layout: { ...candidate.layout,
    topologyWireRoutes: [...(candidate.layout?.topologyWireRoutes ?? []), ...relocated] } };
  validateProjectSnapshot(candidate);
  return { project: candidate, instancePath, instancePaths, affected, fixedRoutesToPlace,
    wiring: { retained: wiring.retained, disconnected: wiring.disconnected } };
}

/** Preflight validates the complete move without writing to the input snapshot. */
export function planInstanceMoves(project: Project, sources: readonly InstancePath[], destination: InstancePath): MovePlan {
  return planMove(project, sources, destination, {});
}

export function planInstanceMove(project: Project, source: InstancePath, destination: InstancePath,
  options: MoveOptions = {}): MovePlan {
  return planMove(project, [source], destination, options);
}

function planMove(project: Project, sources: readonly InstancePath[], destination: InstancePath, options: MoveOptions): MovePlan {
  try {
    return { ok: true, ...applyMove(project, sources, destination, options) };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

/** Apply to the current draft inside a single ProjectStore commit. */
export function moveInstances(project: Project, sources: readonly InstancePath[], destination: InstancePath): Project {
  return verifiedProject(planInstanceMoves(project, sources, destination));
}

export function moveInstance(project: Project, source: InstancePath, destination: InstancePath,
  options?: MoveOptions): Project {
  return verifiedProject(planInstanceMove(project, source, destination, options));
}

function verifiedProject(plan: MovePlan): Project {
  if (!plan.ok) throw new Error(plan.message);
  return plan.project;
}
