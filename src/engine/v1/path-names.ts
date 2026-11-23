import type { ResolvedInstance } from './hierarchy';
import type { InstancePath } from '../../model/v1/types';

export function createPathNames(instances: readonly ResolvedInstance[]) {
  const totals = new Map<string, number>();
  const seen = new Map<string, number>();
  const paths = new Map<string, string>();
  const names = new Map<string, string>();
  const entries = instances.map(({ instancePath, instance, definition }) => {
    const parent = JSON.stringify(instancePath.slice(0, -1));
    const name = instance?.name ?? definition.name;
    const group = JSON.stringify([parent, name, !!instance]);
    totals.set(group, (totals.get(group) ?? 0) + 1);
    return { instancePath, parent, name, group };
  });
  for (const { instancePath, parent, name, group } of entries) {
    const index = (seen.get(group) ?? 0) + 1;
    seen.set(group, index);
    const local = totals.get(group)! > 1 ? `${name}（${index}）` : name;
    const key = JSON.stringify(instancePath);
    names.set(key, local);
    paths.set(key, instancePath.length > 1 ? paths.get(parent) + ' / ' + local : local);
  }
  return {
    showPath(path: InstancePath) {
      const label = paths.get(JSON.stringify(path));
      if (label) return label;
      for (let i = path.length - 1; i >= 0; i--) {
        const parent = paths.get(JSON.stringify(path.slice(0, i)));
        if (parent) return parent + ' / 未找到的对象';
      }
      return '未找到的对象';
    },
    showName: (path: InstancePath) => names.get(JSON.stringify(path)) ?? '未找到的对象',
  };
}
