import { numberedNames } from '../../model/v1/display-names';
import type { ResolvedInstance } from './hierarchy';
import type { InstancePath } from '../../model/v1/types';

export function createPathNames(instances: readonly ResolvedInstance[]) {
  const paths = new Map<string, string>();
  const names = new Map<string, string>();
  const scopes = new Map<string, ResolvedInstance[]>();
  for (const item of instances) {
    const parent = item.instancePath.length ? JSON.stringify(item.instancePath.slice(0, -1)) : '';
    const siblings = scopes.get(parent);
    if (siblings) siblings.push(item);
    else scopes.set(parent, [item]);
  }
  // The hierarchy walk visits parents first, so their display paths are available to child scopes.
  for (const [parent, siblings] of scopes) {
    const labels = numberedNames(siblings.map(item => item.instance?.name ?? item.definition.name));
    siblings.forEach(({ instancePath }, index) => {
      const key = JSON.stringify(instancePath);
      const local = labels[index];
      names.set(key, local);
      paths.set(key, instancePath.length > 1 ? paths.get(parent) + ' / ' + local : local);
    });
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
