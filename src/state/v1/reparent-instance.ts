import { retainWireRoutes } from './wire-routes';
import { resolveHierarchy } from '../../engine/v1/hierarchy';
import type { InstancePath, Project, TopologyPlacement } from '../../model/v1/types';
import { validateProjectSnapshot } from '../../storage/v1/project-json';
import { remapLinkReferences } from './remap-link-references';
import { moveLocalWiring, moveParametersDown, moveParametersUp } from './reparent-wiring';

type OccurrenceMove = { from: InstancePath; to: InstancePath };
type MoveOptions = { position?: Pick<TopologyPlacement, 'x' | 'y'> };
type MovePlan =
  | { ok: true; project: Project; instancePath: InstancePath; instancePaths: readonly InstancePath[];
      affected: readonly OccurrenceMove[]; wiring: { retained: number; disconnected: number } }
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
  const down = destination.length === source.length && startsWith(destination, fromParent);
  const up = fromParent.length > 0 && samePath(destination, fromParent.slice(0, -1));
  if (!down && !up) throw new Error('只能移入同层的兄弟模块，或移到直接上一级。');

  const hierarchy = resolveHierarchy(project);
  const parentPath = down ? fromParent : destination;
  const containerPath = down ? destination : fromParent;
  const parent = hierarchy.resolveInstance(parentPath)?.definition;
  const container = hierarchy.resolveInstance(containerPath)?.definition;
  if (parent?.kind !== 'module' || container?.kind !== 'module') throw new Error('源或目标模块已不存在。');
  const slotId = containerPath.at(-1)!;
  const from = down ? parent : container;
  const to = down ? container : parent;
  const moved = from.instances.filter(instance => moving.has(instance.id));
  if (moved.length !== moving.size) throw new Error('待移动的实例已不存在。');
  const conflict = to.instances.find(instance => moving.has(instance.id));
  if (conflict) throw new Error(`目标模块「${to.name}」已有实例「${conflict.name}」，与移动对象的内部引用冲突。`);

  // A single slot can occur many times through its parents. Another slot would add or lose unmatched occurrences.
  for (const module of project.moduleDefinitions) {
    const other = module.instances.find(instance => instance.definitionId === container.id
      && (module.id !== parent.id || instance.id !== slotId));
    if (other) throw new Error(`模块定义「${container.name}」另被「${module.name} / ${other.name}」使用，无法逐一保留移动对象的出现位置。`);
  }

  const occurrences = [...hierarchy.walkInstances()].filter(item => item.definition.id === parent.id);
  const sourceScopes = new Map(occurrences.map(({ instancePath }) => {
    const nested = [...instancePath, slotId];
    return down ? [key(instancePath), nested] : [key(nested), instancePath];
  }));
  const slot = parent.instances.find(instance => instance.id === slotId)!;
  const perContainerSettings = new Set(project.instanceSettings?.filter(item => !down && sourceScopes.has(key(item.instancePath)))
    .flatMap(item => Object.keys(item.parameterOverrides ?? {})));
  const parameters = down ? moveParametersDown(parent, container, slotId, moving)
    : moveParametersUp(parent, container, slotId, moving,
      id => Object.hasOwn(slot.parameterOverrides ?? {}, id) || perContainerSettings.has(id));
  // Unmapped boundary ports remain valid endpoints. Only direct relationships in the source move or break.
  const wiring = down ? moveLocalWiring(parameters.outer, parameters.inner, moving)
    : moveLocalWiring(parameters.inner, parameters.outer, moving);
  const nextFrom = { ...wiring.source, instances: from.instances.filter(item => !moving.has(item.id)) };
  const nextTo = { ...wiring.destination, instances: [...to.instances, ...moved] };

  const affected = occurrences.flatMap(({ instancePath }) => [...moving].map(id => {
    const sibling = [...instancePath, id];
    const nested = [...instancePath, slotId, id];
    return down ? { from: sibling, to: nested } : { from: nested, to: sibling };
  }));
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
  const candidate = retainWireRoutes(project, {
    ...project,
    moduleDefinitions: project.moduleDefinitions.map(module =>
      module.id === nextFrom.id ? nextFrom : module.id === nextTo.id ? nextTo : module),
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
  validateProjectSnapshot(candidate);
  return { project: candidate, instancePath, instancePaths, affected,
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
