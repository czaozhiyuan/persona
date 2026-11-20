import { resolveHierarchy } from '../../engine/v1/hierarchy';
import type { ComponentDefinition, InstancePath, ModuleDefinition, Project } from '../../model/v1/types';
import { editModule } from './topology-edits';

type Definition = ComponentDefinition | ModuleDefinition;

export function instantiateModule(project: Project, sourcePath: InstancePath, mode: 'reuse' | 'copy',
  instanceId: string, nextDefinitionId: () => string): Project {
  const hierarchy = resolveHierarchy(project);
  const source = hierarchy.resolveInstance(sourcePath);
  const parentPath = sourcePath.slice(0, -1);
  const parent = hierarchy.resolveInstance(parentPath)?.definition;
  if (!source?.instance || source.definition.kind !== 'module' || parent?.kind !== 'module') {
    throw new Error('请先选中一个可复用或复制的模块。');
  }
  const name = source.instance.name + (mode === 'copy' ? ' 副本' : ' 复用');
  const insert = (candidate: Project, definitionId: string) => editModule(candidate, parent.id, module => ({
    ...module, instances: [...module.instances, { id: instanceId, name, definitionId }],
  }));

  if (mode === 'reuse') return insert(project, source.definition.id);

  const definitions = new Map<string, Definition>([...project.moduleDefinitions, ...project.componentDefinitions].map(item => [item.id, item]));
  const copiedIds = new Map<string, string>();
  const pending: Definition[] = [source.definition];
  while (pending.length) {
    const definition = pending.pop()!;
    if (copiedIds.has(definition.id)) continue;
    copiedIds.set(definition.id, nextDefinitionId());
    if (definition.kind === 'module') {
      for (const child of definition.instances) pending.push(definitions.get(child.definitionId)!);
    }
  }

  const modules = [...project.moduleDefinitions];
  const components = [...project.componentDefinitions];
  for (const [oldId, id] of copiedIds) {
    const definition = definitions.get(oldId)!;
    const copy = { ...structuredClone(definition), id };
    if (copy.kind === 'module') {
      modules.push({ ...copy, name: oldId === source.definition.id ? name : copy.name,
        instances: copy.instances.map(child => ({ ...child, definitionId: copiedIds.get(child.definitionId)! })),
      });
    } else components.push(copy);
  }

  const contains = (path: InstancePath) => path.length >= sourcePath.length
    && sourcePath.every((part, index) => path[index] === part);
  const remap = (path: InstancePath): InstancePath => [...parentPath, instanceId, ...path.slice(sourcePath.length)];
  const settings = project.instanceSettings ?? [];
  const localSettings = settings.filter(item => item.instancePath.length > sourcePath.length && contains(item.instancePath))
    .map(item => ({ ...item, instancePath: remap(item.instancePath) }));
  if (source.instance.parameterOverrides && Object.keys(source.instance.parameterOverrides).length) {
    localSettings.push({ instancePath: remap(sourcePath), parameterOverrides: source.instance.parameterOverrides });
  }
  const { layout } = project;

  return insert({
    ...project,
    moduleDefinitions: modules,
    componentDefinitions: components,
    instanceSettings: localSettings.length ? [...settings, ...localSettings] : project.instanceSettings,
    layout: layout && {
      ...layout,
      topology: layout.topology && [...layout.topology, ...layout.topology
        .filter(item => item.instancePath.length > sourcePath.length && contains(item.instancePath))
        .map(item => ({ ...item, instancePath: remap(item.instancePath) }))],
      topologyFrames: layout.topologyFrames && [...layout.topologyFrames, ...layout.topologyFrames
        .filter(item => contains(item.modulePath)).map(item => ({ ...item, modulePath: remap(item.modulePath) }))],
      physical: layout.physical && [...layout.physical, ...layout.physical
        .filter(item => contains(item.instancePath) && contains(item.enclosurePath))
        .map(item => ({ ...item, instancePath: remap(item.instancePath), enclosurePath: remap(item.enclosurePath) }))],
    },
  }, copiedIds.get(source.definition.id)!);
}
