import type { ComponentDefinition, Instance, ModuleDefinition, Project } from '../../model/v1/types';
import { projectErrorMessage, validateProjectSnapshot } from '../../storage/v1/project-json';
import { describeDefinitionChanges } from './definition-changes';

export type LibraryDefinition = ComponentDefinition | ModuleDefinition;

export type TemplateChanges = Readonly<{
  added: readonly LibraryDefinition[];
  reused: readonly LibraryDefinition[];
}>;

function installDefinitions(project: Project, library: readonly LibraryDefinition[], id: string, replace: boolean) {
  const templates = new Map(library.map(item => [item.id, item]));
  const components = new Map(project.componentDefinitions.map(item => [item.id, item]));
  const modules = new Map(project.moduleDefinitions.map(item => [item.id, item]));
  const existing = (key: string) => components.get(key) ?? modules.get(key);
  const pending = [id];
  const visited = new Set<string>();
  const added: LibraryDefinition[] = [];
  const reused: LibraryDefinition[] = [];

  while (pending.length) {
    const key = pending.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    const template = templates.get(key);
    const current = existing(key);
    if (template && current && template.kind !== current.kind) {
      throw new Error(`定义 ID 冲突：「${current.name}」的工程定义类型与库模板不同。`);
    }
    if (current && !(replace && key === id)) {
      // The existing snapshot already owns its dependency closure.
      reused.push(current);
      continue;
    }
    if (!template) throw new Error(`库模板缺少依赖定义，无法安装。`);
    const copy = structuredClone(template);
    if (!current) added.push(copy);
    if (copy.kind === 'component') components.set(key, copy);
    else {
      if (current?.kind === 'module') {
        const previous = new Map(current.instances.map(instance => [instance.id, instance]));
        copy.instances = copy.instances.map(instance => {
          const saved = previous.get(instance.id);
          if (saved && saved.definitionId !== instance.definitionId) {
            throw new Error(`模块「${current.name}」的内部实例「${saved.name}」 改用了其他定义，无法保持原引用。`);
          }
          return saved ?? instance;
        });
      }
      modules.set(key, copy);
      for (const instance of copy.instances) pending.push(instance.definitionId);
    }
  }
  return {
    root: existing(id)!,
    changes: { added, reused },
    project: { ...project, componentDefinitions: [...components.values()], moduleDefinitions: [...modules.values()] },
  };
}

export function addTemplateInstance(project: Project, library: readonly LibraryDefinition[], templateId: string,
  parentId: string, instanceId: string, name: string) {
  if (!library.some(item => item.id === templateId)) throw new Error('所选库模板不存在。');
  if (!project.moduleDefinitions.some(item => item.id === parentId)) throw new Error('当前模块已不存在。');
  const plan = installDefinitions(project, library, templateId, false);
  const instance: Instance = { id: instanceId, name, definitionId: plan.root.id,
    switchStateId: plan.root.kind === 'component' ? plan.root.switchStates?.[0]?.id : undefined };
  return {
    changes: plan.changes,
    project: {
      ...plan.project,
      moduleDefinitions: plan.project.moduleDefinitions.map(module =>
        module.id === parentId ? { ...module, instances: [...module.instances, instance] } : module),
    },
  };
}

/** Validates the entire candidate while replacing only the explicitly selected snapshot. */
export function previewTemplateUpdate(project: Project, library: readonly LibraryDefinition[], templateId: string) {
  const current = [...project.componentDefinitions, ...project.moduleDefinitions].find(item => item.id === templateId);
  const template = library.find(item => item.id === templateId);
  if (!current || !template) throw new Error('没有可更新的工程定义和同 ID 的库模板。');
  const removedPorts = current.kind === template.kind
    ? current.ports.filter(port => !template.ports.some(item => item.id === port.id)).map(port => port.id)
    : [];
  try {
    const candidate = installDefinitions(project, library, templateId, true);
    validateProjectSnapshot(candidate.project);
    return { ok: true as const, project: candidate.project, changes: candidate.changes,
      definitionChanges: describeDefinitionChanges(current, candidate.root) };
  } catch (error) {
    return { ok: false as const, message: projectErrorMessage(error, project), removedPorts };
  }
}
