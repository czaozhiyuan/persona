import { resolveHierarchy } from '../../engine/v1/hierarchy';
import type { LocalEndpointRef } from '../../model/v1/topology';
import type { InstancePath, ModuleDefinition, Project, TopologyPlacement } from '../../model/v1/types';
import { validateProjectSnapshot } from '../../storage/v1/project-json';
import { wireMoveDown, wireMoveUp } from './reparent-wiring';

type OccurrenceMove = { from: InstancePath; to: InstancePath };
type MoveOptions = { position?: Pick<TopologyPlacement, 'x' | 'y'> };
type MovePlan =
  | { ok: true; project: Project; instancePath: InstancePath; affected: readonly OccurrenceMove[] }
  | { ok: false; message: string };

const key = (path: InstancePath) => JSON.stringify(path);
const samePath = (a: InstancePath, b: InstancePath) => key(a) === key(b);
const startsWith = (path: InstancePath, prefix: InstancePath) =>
  path.length >= prefix.length && prefix.every((id, index) => path[index] === id);

function applyMove(project: Project, source: InstancePath, destination: InstancePath, options: MoveOptions) {
  if (!source.length) throw new Error('根模块不能移动。');
  if (startsWith(destination, source)) throw new Error('不能将实例移入自身或其后代。');
  const fromParent = source.slice(0, -1);
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
  const moved = from.instances.find(instance => instance.id === source.at(-1));
  if (!moved) throw new Error('待移动的实例已不存在。');
  if (to.instances.some(instance => instance.id === moved.id)) {
    throw new Error(`目标模块「${to.name}」已有实例 ID「${moved.id}」。`);
  }

  // A single slot can occur many times through its parents. Another slot would add or lose unmatched occurrences.
  for (const module of project.moduleDefinitions) {
    const other = module.instances.find(instance => instance.definitionId === container.id
      && (module.id !== parent.id || instance.id !== slotId));
    if (other) throw new Error(`模块定义「${container.name}」另被「${module.name} / ${other.name}」使用，无法逐一保留移动对象的出现位置。`);
  }

  const definitions = new Map([...project.moduleDefinitions, ...project.componentDefinitions].map(definition => [definition.id, definition]));
  const portsOf = (id: string) => definitions.get(id)!.ports;
  const occurrences = [...hierarchy.walkInstances()].filter(item => item.definition.id === parent.id);
  const containerScopes = new Map(occurrences.map(({ instancePath }) => [key([...instancePath, slotId]), instancePath]));
  const perContainerSettings = new Set(project.instanceSettings?.filter(item => containerScopes.has(key(item.instancePath)))
    .flatMap(item => Object.keys(item.parameterOverrides ?? {})));
  const slot = parent.instances.find(instance => instance.id === slotId)!;
  let aliases: ReadonlyMap<string, LocalEndpointRef> = new Map();
  let relocated: ReadonlyMap<string, string> = new Map();
  let outer: ModuleDefinition;
  let inner: ModuleDefinition;
  if (down) {
    ({ outer, inner } = wireMoveDown(parent, container, slotId, moved, portsOf));
    outer = { ...outer, instances: outer.instances.filter(item => item.id !== moved.id) };
    inner = { ...inner, instances: [...inner.instances, moved] };
  } else {
    ({ outer, inner, aliases, relocated } = wireMoveUp(parent, container, slotId, moved, portsOf,
      id => Object.hasOwn(slot.parameterOverrides ?? {}, id) || perContainerSettings.has(id)));
    outer = { ...outer, instances: [...outer.instances, moved] };
    inner = { ...inner, instances: inner.instances.filter(item => item.id !== moved.id) };
  }

  const affected = occurrences.map(({ instancePath }) => {
    const sibling = [...instancePath, moved.id];
    const nested = [...instancePath, slotId, moved.id];
    return down ? { from: sibling, to: nested } : { from: nested, to: sibling };
  });
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

  function atPort<T extends { instancePath: InstancePath; portId: string }>(endpoint: T): T {
    const scope = containerScopes.get(key(endpoint.instancePath));
    const unwrapped = scope && aliases.get(endpoint.portId);
    return unwrapped
      ? { ...endpoint, instancePath: [...scope, unwrapped.instanceId], portId: unwrapped.portId }
      : atInstance(endpoint);
  }

  const instancePath = remap(source);
  const layout = project.layout;
  const topology = layout?.topology?.map(atInstance);
  const position = options.position;
  const candidate: Project = {
    ...project,
    moduleDefinitions: project.moduleDefinitions.map(module =>
      module.id === outer.id ? outer : module.id === inner.id ? inner : module),
    instanceSettings: project.instanceSettings?.map(atInstance),
    namedLinks: project.namedLinks?.map(link => ({
      ...link, from: link.from && atPort(link.from), to: link.to && atPort(link.to),
      via: link.via?.map(ref => {
        if ('connectionId' in ref) {
          const scopePath = containerScopes.get(key(ref.scopePath));
          const connectionId = scopePath && relocated.get(ref.connectionId);
          if (connectionId !== undefined && scopePath) return { scopePath, connectionId };
        }
        return { ...ref, scopePath: remap(ref.scopePath) };
      }),
      conversionBindings: link.conversionBindings?.map(binding => ({
        ...binding, eo: atInstance(binding.eo), oe: atInstance(binding.oe),
      })),
      ...(link.trial && { trial: { ...link.trial, opticalSources: link.trial.opticalSources?.map(source => ({
        ...source, endpoint: atPort(source.endpoint),
      })) } }),
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
  };
  validateProjectSnapshot(candidate);
  return { project: candidate, instancePath, affected };
}

/** Preflight returns a fully validated candidate without writing to the input snapshot. */
export function planInstanceMove(project: Project, source: InstancePath, destination: InstancePath,
  options: MoveOptions = {}): MovePlan {
  try {
    return { ok: true, ...applyMove(project, source, destination, options) };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

/** Apply to the current draft inside a single ProjectStore commit. */
export function moveInstance(project: Project, source: InstancePath, destination: InstancePath,
  options?: MoveOptions): Project {
  const plan = planInstanceMove(project, source, destination, options);
  if (!plan.ok) throw new Error(plan.message);
  return plan.project;
}
