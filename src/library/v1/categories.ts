import { blankComponentId, blankEnclosureId, blankModuleId } from './built-in';
import type { LibraryDefinition } from './project-snapshots';

const categories = [
  ['光电器件', ['library-laser', 'library-dml', 'library-optical-source', 'library-mzm', 'library-pd', 'library-optical-switch',
    'library-optical-attenuator', 'library-splitter', 'library-sfp']],
  ['射频器件', ['library-rf-amplifier', 'library-rf-attenuator']],
  ['电源与控制', ['library-dc-supply', 'library-dc-converter', 'library-pcb']],
  ['我的模板', []],
  ['示例模板', ['library-rf-gain', 'library-rf-stage']],
] as const;

export const creationLabels = new Map([[blankComponentId, '新建器件'], [blankModuleId, '新建模块'], [blankEnclosureId, '新建机箱']]);
const abbreviations: Readonly<Record<string, string>> = {
  'library-mzm': 'MZM', 'library-dml': 'DML', 'library-pd': 'PD', 'library-sfp': 'SFP',
  'library-dc-converter': 'DC/DC', 'library-rf-amplifier': 'RF', 'library-rf-attenuator': 'RF',
};
export function templateMatches(id: string, label: string, query: string) {
  return (label + ' ' + (abbreviations[id] ?? '')).toLowerCase().includes(query);
}

const known = new Set<string>(categories.flatMap(([, ids]) => [...ids]));
export function libraryGroups(definitions: readonly LibraryDefinition[]) {
  const byId = new Map(definitions.map(d => [d.id, d]));
  return categories.map(([name, ids]) => ({ name, items: name === '我的模板'
    ? definitions.filter(item => !known.has(item.id) && !creationLabels.has(item.id))
    : ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []) }));
}
