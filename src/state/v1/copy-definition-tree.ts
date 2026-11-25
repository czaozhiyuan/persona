import type { ComponentDefinition, ModuleDefinition, Project } from '../../model/v1/types';

type Definition = ComponentDefinition | ModuleDefinition;

/** Expand the validated source graph per occurrence, keeping all module-local IDs intact. */
export function copyDefinitionTree(project: Project, source: readonly Definition[], rootId: string,
  nextId: () => string, rootName?: string) {
  const originals = new Map(source.map(definition => [definition.id, definition]));
  const copies: Definition[] = [];
  function copy(id: string) {
    const original = originals.get(id);
    if (!original) throw new Error('待复制的器件或模块定义不存在。');
    const definition = structuredClone(original);
    definition.id = nextId();
    copies.push(definition);
    return definition;
  }
  const root = copy(rootId);
  if (rootName !== undefined) root.name = rootName;
  for (const definition of copies) {
    if (definition.kind === 'module') {
      for (const child of definition.instances) child.definitionId = copy(child.definitionId).id;
    }
  }
  return { root, project: { ...project,
    componentDefinitions: [...project.componentDefinitions, ...copies.filter(d => d.kind === 'component')],
    moduleDefinitions: [...project.moduleDefinitions, ...copies.filter(d => d.kind === 'module')],
  } };
}
