import type { ResolvedInstance } from '../../engine/v1/hierarchy';
import type { InstancePath } from '../../model/v1/types';

function occurrenceName(path: InstancePath, names: ReadonlyMap<string, string>): string {
  return path.length ? path.map((id, index) => names.get(JSON.stringify(path.slice(0, index + 1))) ?? id).join(' / ')
    : names.get('[]') ?? '系统';
}

export function structureScope(instances: readonly ResolvedInstance[], definitionId: string): readonly string[] {
  const occurrences = instances.filter(item => item.definition.id === definitionId);
  if (occurrences.length < 2) return [];
  const names = new Map(instances.map(item => [JSON.stringify(item.instancePath), item.instance?.name ?? item.definition.name]));
  const labels = occurrences.map(item => occurrenceName(item.instancePath, names));
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return occurrences.map((item, index) => counts.get(labels[index]) === 1 ? labels[index]
    : `${labels[index]} (${item.instancePath.join(' / ')})`);
}
