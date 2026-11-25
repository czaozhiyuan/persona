import { moduleName } from '../../state/v1/module-name';
import type { InstancePath, Project } from '../../model/v1/types';
import { moveTopologyNode } from '../../state/v1/topology-edits';
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
  if (item.source === 'template' && config.hidden.includes(item.id)) throw new Error('此模板已隐藏。');
  const source = item.source === 'project' ? [...project.moduleDefinitions, ...project.componentDefinitions]
    : item.source === 'blank-module' ? builtInDefinitions : libraryDefinitions(config);
  const definition = source.find(def => def.id === item.id);
  if (!definition) throw new Error('所选器件或模块已不存在。');
  const name = definition.kind === 'module' ? moduleName(project, item.name, { automatic: item.automaticName }) : item.name;
  const updated = addTemplateInstance(project, source, item.id, moduleId, instanceId, name,
    item.source !== 'project' && isBlankTemplate(item.id) ? name : undefined);
  return position ? moveTopologyNode(updated, [...modulePath, instanceId], position) : updated;
}
