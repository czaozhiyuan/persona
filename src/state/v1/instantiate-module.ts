import { moduleName } from './module-name';
import { resolveHierarchy } from '../../engine/v1/hierarchy';
import { copyDefinitionTree } from './copy-definition-tree';
import type { InstancePath, Project } from '../../model/v1/types';
import { editModule } from './topology-edits';

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
  const sourceHierarchy = resolveHierarchy(copiedProject);
  const source = sourceHierarchy.resolveInstance(sourcePath);
  const parent = (project === copiedProject ? sourceHierarchy : resolveHierarchy(project)).resolveInstance(parentPath)?.definition;
  if (!source?.instance || source.definition.kind !== 'module' || parent?.kind !== 'module') {
    throw new Error('请选择一个可复制的模块，并在模块视图中粘贴。');
  }
  const name = moduleName(project, source.instance.name + ' 副本', { automatic: true });
  const copy = copyDefinitionTree(project, [...copiedProject.moduleDefinitions, ...copiedProject.componentDefinitions],
    source.definition.id, nextDefinitionId, name);
  const contains = (path: InstancePath) => path.length >= sourcePath.length
    && sourcePath.every((part, index) => path[index] === part);
  const remap = (path: InstancePath): InstancePath => [...parentPath, instanceId, ...path.slice(sourcePath.length)];
  const settings = project.instanceSettings ?? [];
  const localSettings = (copiedProject.instanceSettings ?? []).filter(item => item.instancePath.length > sourcePath.length && contains(item.instancePath))
    .map(item => ({ ...item, instancePath: remap(item.instancePath) }));
  if (source.instance.parameterOverrides && Object.keys(source.instance.parameterOverrides).length) {
    localSettings.push({ instancePath: remap(sourcePath), parameterOverrides: source.instance.parameterOverrides });
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
  return editModule(candidate, parent.id, module => ({
    ...module, instances: [...module.instances, { id: instanceId, name, definitionId: copy.root.id }],
  }));
}
