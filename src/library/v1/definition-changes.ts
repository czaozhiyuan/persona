import type { ComponentDefinition, ModuleDefinition } from '../../model/v1/types';

type Definition = ComponentDefinition | ModuleDefinition;
export type DefinitionChange = {
  field: string;
  id?: string;
  before: unknown;
  after: unknown;
};

function comparable(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}

/** Compares the validated update candidate, including preserved local instance settings. */
export function describeDefinitionChanges(before: Definition, after: Definition): DefinitionChange[] {
  const changes: DefinitionChange[] = [];
  function record(field: string, oldValue: unknown, newValue: unknown, id?: string) {
    if (comparable(oldValue) !== comparable(newValue)) changes.push({ field, id, before: oldValue, after: newValue });
  }
  function records<T>(field: string, oldItems: readonly T[] = [], newItems: readonly T[] = [], key: (item: T) => string) {
    const oldById = new Map(oldItems.map(item => [key(item), item]));
    const newById = new Map(newItems.map(item => [key(item), item]));
    for (const id of new Set([...oldById.keys(), ...newById.keys()])) {
      record(field, oldById.get(id), newById.get(id), id);
    }
    const oldOrder = [...oldById.keys()].filter(id => newById.has(id));
    const newOrder = [...newById.keys()].filter(id => oldById.has(id));
    record(`${field}顺序`, oldOrder, newOrder);
  }
  const idOf = (item: { id: string }) => item.id;

  record('定义名称', before.name, after.name);
  records('端口', before.ports, after.ports, idOf);
  records('参数定义', before.parameters, after.parameters, idOf);
  if (before.kind === 'module' && after.kind === 'module') {
    records('内部实例', before.instances, after.instances, idOf);
    records('连接', before.connections, after.connections, idOf);
    records('多芯线缆', before.cableBundles, after.cableBundles, idOf);
    records('端口映射', before.portMappings, after.portMappings, item => item.portId);
    records('参数映射', before.parameterMappings, after.parameterMappings,
      item => JSON.stringify([item.target.instanceId, item.target.parameterId]));
    record('物理包络', before.physicalEnclosure, after.physicalEnclosure);
  }
  if (before.kind === 'component' && after.kind === 'component') {
    record('框图图标', before.iconKey, after.iconKey);
    record('参考占位宽深', before.physicalFootprint, after.physicalFootprint);
    record('器件传输', before.transfers ?? [], after.transfers ?? []);
    records('开关状态与路由', before.switchStates, after.switchStates, idOf);
  }
  return changes;
}
