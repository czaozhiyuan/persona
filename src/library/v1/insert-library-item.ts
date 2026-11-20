import type { InstancePath, Project } from '../../model/v1/types';
import { editModule, moveTopologyNode } from '../../state/v1/topology-edits';
import { blankEnclosureId, blankModuleId, builtInDefinitions } from './built-in';
import { addTemplateInstance } from './project-snapshots';

export type LibraryItem = { source: 'template' | 'project'; id: string; name: string };
export const libraryDragType = 'application/x-persona-library-item';

export function readLibraryItem(data: DataTransfer): LibraryItem | undefined {
  try {
    const item: unknown = JSON.parse(data.getData(libraryDragType));
    if (item && typeof item === 'object' && 'source' in item && 'id' in item && 'name' in item
      && (item.source === 'template' || item.source === 'project')
      && typeof item.id === 'string' && typeof item.name === 'string' && item.name.trim()) {
      return { source: item.source, id: item.id, name: item.name.trim() };
    }
  } catch {
    return;
  }
}

export function insertLibraryItem(project: Project, item: LibraryItem, moduleId: string, modulePath: InstancePath,
  instanceId: string, position?: { x: number; y: number }): Project {
  let updated: Project;
  if (item.source === 'project') {
    const definition = [...project.moduleDefinitions, ...project.componentDefinitions].find(entry => entry.id === item.id);
    if (!definition) throw new Error('所选器件或模块已不存在。');
    updated = editModule(project, moduleId, module => ({
      ...module, instances: [...module.instances, {
        id: instanceId, name: item.name, definitionId: item.id,
        switchStateId: definition.kind === 'component' ? definition.switchStates?.[0]?.id : undefined,
      }],
    }));
  } else if (item.id === blankModuleId || item.id === blankEnclosureId) {
    const template = builtInDefinitions.find(entry => entry.id === item.id)!;
    const definition = { ...template, id: instanceId, name: item.name };
    updated = addTemplateInstance(project, [definition], definition.id, moduleId, instanceId, item.name).project;
  } else {
    updated = addTemplateInstance(project, builtInDefinitions, item.id, moduleId, instanceId, item.name).project;
  }
  return position ? moveTopologyNode(updated, [...modulePath, instanceId], position) : updated;
}
