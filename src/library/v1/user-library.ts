import { resolveHierarchy } from '../../engine/v1/hierarchy';
import type { InstancePath, ModuleDefinition, Project } from '../../model/v1/types';
import { discardImportedPortSides, validateProjectSnapshot } from '../../storage/v1/project-json';
import { builtInDefinitions } from './built-in';
import type { LibraryDefinition } from './project-snapshots';

export type LibraryConfig = {
  format: 'persona-library';
  schemaVersion: 1;
  overrides: LibraryDefinition[];
  custom: LibraryDefinition[];
  hidden: string[];
};

export function factoryLibrary(): LibraryConfig {
  return { format: 'persona-library', schemaVersion: 1, overrides: [], custom: [], hidden: [] };
}

export const factory = new Map<string, LibraryDefinition>(builtInDefinitions.map(d => [d.id, d]));

export function libraryDefinitions(config: LibraryConfig): LibraryDefinition[] {
  const overrides = new Map(config.overrides.map(d => [d.id, d]));
  const definitions = builtInDefinitions.map(d => {
    const override = overrides.get(d.id);
    if (override) return override;
    if (d.id === 'library-rf-stage') {
      const gain = overrides.get('library-rf-gain');
      if (gain && !gain.ports.some(p => p.id === 'DC_IN' && p.type === 'DC_POWER' && p.direction === 'in')) {
        // A saved gain template can predate the factory module's optional power input.
        return { ...d, ports: d.ports.filter(p => p.id !== 'DC_IN'), portMappings: d.portMappings.filter(m => m.portId !== 'DC_IN') };
      }
    }
    return d;
  });
  return [...definitions, ...config.custom];
}

export function validateLibrary(value: unknown): asserts value is LibraryConfig {
  if (!value || typeof value !== 'object') throw new Error('请选择器件库 JSON 文件。');
  const config = value as LibraryConfig;
  if (config.format !== 'persona-library' || config.schemaVersion !== 1
    || Object.keys(config).some(key => !Object.hasOwn(factoryLibrary(), key))
    || !Array.isArray(config.overrides) || !Array.isArray(config.custom) || !Array.isArray(config.hidden)) {
    throw new Error('器件库文件格式或版本无效。');
  }
  const seen = new Set<string>();
  for (const [list, builtin] of [[config.overrides, true], [config.custom, false]] as const) {
    for (const d of list) {
      if (!d || typeof d.id !== 'string' || !d.id.trim() || seen.has(d.id) || factory.has(d.id) !== builtin
        || !['module', 'component'].includes(d.kind) || (builtin && factory.get(d.id)?.kind !== d.kind)) {
        throw new Error('模板标识重复、类型无效或与内置模板冲突。');
      }
      seen.add(d.id);
    }
  }
  if (new Set(config.hidden).size !== config.hidden.length || config.hidden.some(id => !factory.has(id))) {
    throw new Error('隐藏列表含重复项或未知内置模板。');
  }
  const definitions = libraryDefinitions(config);
  const ids = new Set(definitions.map(d => d.id));
  for (const definition of definitions) {
    if (typeof definition.name !== 'string' || !definition.name.trim()) throw new Error('模板名称不能为空。');
    if (definition.kind === 'module' && Array.isArray(definition.instances)
      && definition.instances.some(i => !i || !ids.has(i.definitionId))) {
      throw new Error('模块「' + definition.name + '」引用了不存在的子模板。');
    }
  }
  let rootId = 'library-validation-root';
  while (ids.has(rootId)) rootId += '-';
  const root: ModuleDefinition = { kind: 'module', id: rootId, name: '器件库', ports: [], instances: [] };
  validateProjectSnapshot({ id: 'library', name: root.name, rootModuleDefinitionId: rootId,
    componentDefinitions: definitions.filter(d => d.kind === 'component'),
    moduleDefinitions: [root, ...definitions.filter(d => d.kind === 'module')] });
}

export function parseLibrary(source: string): LibraryConfig {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error('器件库 JSON 语法无效。'); }
  validateLibrary(value);
  discardImportedPortSides([...value.overrides, ...value.custom]);
  return value;
}

export function saveDefinition(config: LibraryConfig, definition: LibraryDefinition): LibraryConfig {
  const list = factory.has(definition.id) ? 'overrides' : 'custom';
  const entries = config[list];
  const exists = entries.some(d => d.id === definition.id);
  return { ...config, [list]: exists ? entries.map(d => d.id === definition.id ? definition : d) : [...entries, definition] };
}

export function removeDefinition(config: LibraryConfig, id: string): LibraryConfig {
  if (factory.has(id)) return { ...config, hidden: [...new Set([...config.hidden, id])] };
  const dependent = libraryDefinitions(config).find(d => d.kind === 'module' && d.instances.some(i => i.definitionId === id));
  if (dependent) throw new Error('库模块「' + dependent.name + '」仍引用此模板，请先修改模块。');
  return { ...config, custom: config.custom.filter(d => d.id !== id) };
}

export function restoreDefinition(config: LibraryConfig, id: string): LibraryConfig {
  return { ...config, hidden: config.hidden.filter(item => item !== id), overrides: config.overrides.filter(d => d.id !== id) };
}

export function captureInstance(project: Project, path: InstancePath, effective: boolean): LibraryDefinition[] {
  const occurrence = resolveHierarchy(project).resolveInstance(path);
  if (!occurrence) throw new Error('请选择工程中的器件或模块。');
  if (project.instanceSettings?.some(s => s.instancePath.length > path.length && path.every((id, i) => s.instancePath[i] === id))) {
    throw new Error('此模块的子实例有独立设置，请先将设置写入模块定义，或单独保存子器件。');
  }
  const definitions = new Map([...project.componentDefinitions, ...project.moduleDefinitions].map(d => [d.id, d]));
  const copies = new Map<string, LibraryDefinition>();
  const pending = [occurrence.definition.id];
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index];
    if (copies.has(id)) continue;
    const clone = structuredClone(definitions.get(id)!);
    clone.id = crypto.randomUUID();
    copies.set(id, clone);
    if (clone.kind === 'module') for (const slot of clone.instances) pending.push(slot.definitionId);
  }
  for (const clone of copies.values()) {
    if (clone.kind === 'module') clone.instances = clone.instances.map(i => ({ ...i, definitionId: copies.get(i.definitionId)!.id }));
  }
  const draft = copies.get(occurrence.definition.id)!;
  draft.name = occurrence.instance?.name ?? draft.name;
  if (effective && draft.parameters) draft.parameters = draft.parameters.map(p => {
    const value = occurrence.parameters.get(p.id)?.value;
    if (p.kind === 'numeric') return { ...p, defaultValue: typeof value === 'object' ? value : undefined };
    return { ...p, defaultValue: typeof value === 'string' ? value : undefined };
  });
  if (effective && draft.kind === 'component' && occurrence.switchState && draft.switchStates) {
    draft.switchStates = [occurrence.switchState, ...draft.switchStates.filter(s => s.id !== occurrence.switchState!.id)];
  }
  return [...copies.values()];
}
