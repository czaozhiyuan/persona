import { moduleName } from '../../state/v1/module-name';
import type { InstancePath, Project } from '../../model/v1/types';
import { editModule, moveTopologyNode } from '../../state/v1/topology-edits';
import { builtInDefinitions, isBlankTemplate } from './built-in';
import { factoryLibrary, libraryDefinitions } from './user-library';
import type { LibraryConfig } from './user-library';
import { addTemplateInstance } from './project-snapshots';

export type LibraryItem = { source: 'template' | 'project' | 'blank-module'; id: string; name: string; automaticName?: boolean };
export const libraryDragType = 'application/x-persona-library-item';

export function readLibraryItem(data: DataTransfer): LibraryItem | undefined {
  try {
    const item: unknown = JSON.parse(data.getData(libraryDragType));
    if (item && typeof item === 'object' && 'source' in item && 'id' in item && 'name' in item
      && (item.source === 'template' || item.source === 'project')
      && typeof item.id === 'string' && typeof item.name === 'string' && item.name.trim()) {
      return { source: item.source, id: item.id, name: item.name.trim(), automaticName: 'automaticName' in item && item.automaticName === true };
    }
  } catch {
    return;
  }
}

export function insertLibraryItem(project: Project, item: LibraryItem, moduleId: string, modulePath: InstancePath,
  instanceId: string, position?: { x: number; y: number }, config: LibraryConfig = factoryLibrary()): Project {
  const library = item.source === 'blank-module' ? builtInDefinitions : libraryDefinitions(config);
  if (item.source === 'template' && config.hidden.includes(item.id)) throw new Error('此模板已隐藏。');
  const module = (item.source === 'project' ? project.moduleDefinitions : library)
    .some(def => def.id === item.id && def.kind === 'module');
  const name = module ? moduleName(project, item.name, { automatic: item.automaticName }) : item.name;
  let updated: Project;
  if (item.source === 'project') {
    const definition = [...project.moduleDefinitions, ...project.componentDefinitions].find(entry => entry.id === item.id);
    if (!definition) throw new Error('所选器件或模块已不存在。');
    updated = editModule(project, moduleId, module => ({
      ...module, instances: [...module.instances, {
        id: instanceId, name, definitionId: item.id,
        switchStateId: definition.kind === 'component' ? definition.switchStates?.[0]?.id : undefined,
      }],
    }));
  } else if (isBlankTemplate(item.id)) {
    const template = library.find(entry => entry.id === item.id)!;
    const definition = { ...template, id: instanceId, name };
    updated = addTemplateInstance(project, [...library, definition], definition.id, moduleId, instanceId, name).project;
  } else {
    updated = addTemplateInstance(project, library, item.id, moduleId, instanceId, name).project;
  }
  return position ? moveTopologyNode(updated, [...modulePath, instanceId], position) : updated;
}
