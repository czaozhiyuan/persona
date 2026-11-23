import { resolveHierarchy } from '../../engine/v1/hierarchy';
import type { InstancePath, Project } from '../../model/v1/types';

export function moduleName(project: Project, requested: string, options: { automatic?: boolean; except?: InstancePath } = {}) {
  const name = requested.trim();
  if (!name) throw new Error('模块名称不能为空。');
  const occupied = new Set<string>();
  const except = JSON.stringify(options.except);
  for (const item of resolveHierarchy(project).walkInstances()) {
    if (item.definition.kind === 'module' && JSON.stringify(item.instancePath) !== except) {
      occupied.add((item.instance?.name ?? item.definition.name).trim().toLowerCase());
    }
  }
  if (!occupied.has(name.toLowerCase())) return name;
  if (!options.automatic) throw new Error(`模块名称「${name}」已存在，请使用其他名称。`);
  let suffix = 2;
  while (occupied.has(`${name} ${suffix}`.toLowerCase())) suffix++;
  return `${name} ${suffix}`;
}
