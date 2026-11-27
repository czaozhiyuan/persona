import { offsetRoute } from './wire-routes';
import { moduleName } from './module-name';
import type { ResolvedInstance } from '../../engine/v1/hierarchy';
import { resolveHierarchy } from '../../engine/v1/hierarchy';
import { copyDefinitionTree } from './copy-definition-tree';
import type { InstancePath, Project, TopologyWireRoute, WireRef } from '../../model/v1/types';
import type { Connection, CableBundle, LocalEndpointRef } from '../../model/v1/topology';
import { wireRouteKey } from '../../model/v1/wire-route';
import { editModule, moveTopologyNodes } from './topology-edits';

export function instantiateModule(project: Project, sourcePath: InstancePath, mode: 'reuse' | 'copy',
  instanceId: string, nextDefinitionId: () => string): Project {
  const parentPath = sourcePath.slice(0, -1);
  if (mode === 'copy') return pasteModule(project, project, sourcePath, parentPath, instanceId, nextDefinitionId);

  const hierarchy = resolveHierarchy(project);
  const source = hierarchy.resolveInstance(sourcePath);
  const parent = hierarchy.resolveInstance(parentPath)?.definition;
  if (!source?.instance || source.definition.kind !== 'module' || parent?.kind !== 'module') {
    throw new Error('请先选中一个可复用或复制的模块。');
  }
  const name = moduleName(project, source.instance.name + ' 复用', { automatic: true });
  return editModule(project, parent.id, module => ({
    ...module, instances: [...module.instances, { id: instanceId, name, definitionId: source.definition.id }],
  }));
}

export function pasteModule(project: Project, copiedProject: Project, sourcePath: InstancePath, parentPath: InstancePath,
  instanceId: string, nextDefinitionId: () => string): Project {
  return pasteTopologyObjects(project, copiedProject, [{ path: sourcePath, id: instanceId }], parentPath, nextDefinitionId);
}

type Point = { x: number; y: number };
type PasteRoot = { path: InstancePath; id: string; position?: Point; routeOffset?: Point };

export function pasteTopologyObjects(project: Project, snapshot: Project, roots: readonly PasteRoot[], destination: InstancePath,
  nextId: () => string): Project {
  const hierarchy = resolveHierarchy(snapshot);
  const owner = resolveHierarchy(project).resolveInstance(destination)?.definition;
  if (owner?.kind !== 'module' || !roots.length) throw new Error('请选择有效对象，并在模块视图中粘贴。');
  const groups = new Map<string, { path: InstancePath; slots: Map<string, string>; routeOffset?: Point }>();
  for (const root of roots) {
    const source = hierarchy.resolveInstance(root.path);
    if (!source?.instance) throw new Error('剪贴板包含无效对象。');
    project = copyRoot(project, snapshot, source, destination, owner.id, root.id, nextId);
    const path = root.path.slice(0, -1);
    const key = JSON.stringify(path);
    const group = groups.get(key) ?? { path, slots: new Map<string, string>(), routeOffset: root.routeOffset };
    group.slots.set(source.instance.id, root.id);
    groups.set(key, group);
  }

  const connections: Connection[] = [];
  const bundles: CableBundle[] = [];
  const routes: TopologyWireRoute[] = [];
  const sourceRoutes = new Map(snapshot.layout?.topologyWireRoutes?.map(r => [wireRouteKey(r.modulePath, r.wire), r]));
  for (const { path, slots, routeOffset } of groups.values()) {
    const parent = hierarchy.resolveInstance(path)!.definition;
    if (parent.kind !== 'module') throw new Error('所复制对象的父模块无效。');
    function endpoint(ref?: LocalEndpointRef) {
      const instanceId = ref && slots.get(ref.instanceId);
      return instanceId && ref ? { ...ref, instanceId } : undefined;
    }
    function copyRoute(from: WireRef, to: WireRef) {
      const original = sourceRoutes.get(wireRouteKey(path, from));
      if (original && routeOffset) routes.push({ ...offsetRoute(original, routeOffset), modulePath: destination, wire: to });
    }
    for (const c of parent.connections ?? []) {
      const from = endpoint(c.from), to = endpoint(c.to);
      if (!from || !to) continue;
      const id = nextId();
      connections.push({ ...c, id, from, to });
      copyRoute({ kind: 'connection', id: c.id }, { kind: 'connection', id });
    }
    for (const bundle of parent.cableBundles ?? []) {
      const cores = bundle.cores.flatMap(core => {
        const a = endpoint(core.a.endpoint), b = endpoint(core.b.endpoint);
        return a && b ? [{ ...core, a: { ...core.a, endpoint: a }, b: { ...core.b, endpoint: b } }] : [];
      });
      if (!cores.length) continue;
      const id = nextId();
      bundles.push({ ...bundle, id, cores });
      for (const core of cores) copyRoute({ kind: 'core', id: core.id, bundleId: bundle.id },
        { kind: 'core', id: core.id, bundleId: id });
    }
  }
  if (connections.length || bundles.length) project = editModule(project, owner.id, module => ({ ...module,
    connections: connections.length ? [...(module.connections ?? []), ...connections] : module.connections,
    cableBundles: bundles.length ? [...(module.cableBundles ?? []), ...bundles] : module.cableBundles,
  }));
  if (routes.length) project = { ...project, layout: { ...project.layout,
    topologyWireRoutes: [...(project.layout?.topologyWireRoutes ?? []), ...routes] } };
  return moveTopologyNodes(project, roots.flatMap(root => root.position
    ? [{ instancePath: [...destination, root.id], ...root.position }] : []));
}

function copyRoot(project: Project, copiedProject: Project, source: ResolvedInstance, parentPath: InstancePath,
  parentId: string, instanceId: string, nextDefinitionId: () => string): Project {
  const sourcePath = source.instancePath;
  const instance = source.instance!;
  const module = source.definition.kind === 'module';
  const name = module ? moduleName(project, instance.name + ' 副本', { automatic: true }) : instance.name;
  const copy = copyDefinitionTree(project, [...copiedProject.moduleDefinitions, ...copiedProject.componentDefinitions],
    source.definition.id, nextDefinitionId, module ? name : undefined);
  const contains = (path: InstancePath) => path.length >= sourcePath.length
    && sourcePath.every((part, index) => path[index] === part);
  const remap = (path: InstancePath): InstancePath => [...parentPath, instanceId, ...path.slice(sourcePath.length)];
  const settings = project.instanceSettings ?? [];
  const localSettings = (copiedProject.instanceSettings ?? []).filter(item => item.instancePath.length > sourcePath.length && contains(item.instancePath))
    .map(item => ({ ...item, instancePath: remap(item.instancePath) }));
  const overrides = Object.fromEntries([...source.parameters].filter(([, p]) => p.source.kind !== 'default')
    .map(([id, p]) => [id, p.value]));
  if (Object.keys(overrides).length) {
    localSettings.push({ instancePath: remap(sourcePath), parameterOverrides: overrides });
  }
  const { layout } = project;
  const copiedLayout = copiedProject.layout;
  const topology = copiedLayout?.topology?.filter(item => item.instancePath.length > sourcePath.length && contains(item.instancePath))
    .map(item => ({ ...item, instancePath: remap(item.instancePath) }));
  const topologyFrames = copiedLayout?.topologyFrames?.filter(item => contains(item.modulePath))
    .map(item => ({ ...item, modulePath: remap(item.modulePath) }));
  const routes = copiedLayout?.topologyWireRoutes?.filter(item => contains(item.modulePath))
    .map(item => ({ ...item, modulePath: remap(item.modulePath) }));
  const physical = copiedLayout?.physical?.filter(item => contains(item.instancePath) && contains(item.enclosurePath))
    .map(item => ({ ...item, instancePath: remap(item.instancePath), enclosurePath: remap(item.enclosurePath) }));
  const candidate: Project = {
    ...copy.project,
    instanceSettings: localSettings.length ? [...settings, ...localSettings] : project.instanceSettings,
    layout: layout || topology?.length || topologyFrames?.length || routes?.length || physical?.length ? {
      ...layout,
      topology: topology?.length ? [...(layout?.topology ?? []), ...topology] : layout?.topology,
      topologyWireRoutes: routes?.length ? [...(layout?.topologyWireRoutes ?? []), ...routes] : layout?.topologyWireRoutes,
      topologyFrames: topologyFrames?.length ? [...(layout?.topologyFrames ?? []), ...topologyFrames] : layout?.topologyFrames,
      physical: physical?.length ? [...(layout?.physical ?? []), ...physical] : layout?.physical,
    } : undefined,
  };
  return editModule(candidate, parentId, module => ({
    ...module, instances: [...module.instances, { id: instanceId, name, definitionId: copy.root.id, switchStateId: instance.switchStateId }],
  }));
}
