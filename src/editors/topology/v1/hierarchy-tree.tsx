import { Fragment } from 'react';
import { portDisplayName, portTypeLabels } from '../../../workbench/v1/labels';
import type { ResolvedInstance } from '../../../engine/v1/hierarchy';
import type { InstancePath } from '../../../model/v1/types';
import { hierarchyChildren, hierarchyKey } from './hierarchy-view';

type Props = {
  instances: readonly ResolvedInstance[];
  modulePath: InstancePath;
  selected?: InstancePath;
  expanded: ReadonlySet<string>;
  toggle: (path: InstancePath) => void;
  navigate: (path: InstancePath, module: boolean) => void;
  navigatePort: (path: InstancePath, portId: string) => void;
};

export function HierarchyTree({ instances, modulePath, selected, expanded, toggle, navigate, navigatePort }: Props) {
  const children = hierarchyChildren(instances);
  const root = instances[0];
  const pending = root ? [root] : [];
  const rows: ResolvedInstance[] = [];
  const active = hierarchyKey(modulePath);
  const selectedKey = selected && hierarchyKey(selected);
  while (pending.length) {
    const occurrence = pending.pop()!;
    rows.push(occurrence);
    if (expanded.has(hierarchyKey(occurrence.instancePath))) {
      for (const child of [...(children.get(hierarchyKey(occurrence.instancePath)) ?? [])].reverse()) pending.push(child);
    }
  }
  return <div className="v1-hierarchy-tree" aria-label="工程结构">
    <ul>
      {rows.map(({ instancePath, instance, definition }) => {
        const key = hierarchyKey(instancePath);
        const name = instance?.name ?? definition.name;
        const open = expanded.has(key);
        const module = definition.kind === 'module';
        const hasChildren = !!children.get(key)?.length || (module && definition.ports.length > 0);
        return <Fragment key={key}><li style={{ paddingInlineStart: 4 + instancePath.length * 14 }}>
          {hasChildren ? <button type="button" className="v1-hierarchy-disclosure" aria-expanded={open}
            aria-label={`${open ? '折叠' : '展开'} ${name}`} onClick={() => toggle(instancePath)}>{open ? '▾' : '▸'}</button>
            : <span className="v1-hierarchy-disclosure" />}
          <button type="button" className="v1-hierarchy-entry" title={`${name} · ${definition.name}`}
            aria-label={`定位 ${name}`}
            aria-current={key === active ? 'location' : undefined} aria-pressed={key === selectedKey}
            onClick={() => navigate(instancePath, module)}>
            <span className={`v1-hierarchy-icon ${module ? 'module' : ''}`} aria-hidden="true" />
            <span>{name}</span>
          </button>
        </li>
          {open && module && definition.ports.map(port => <li className="v1-tree-port" key={port.id}
            style={{ paddingInlineStart: 4 + (instancePath.length + 1) * 14 }}>
            <button type="button" onClick={() => navigatePort(instancePath, port.id)}
              title={`对外端口 · ${portTypeLabels[port.type]} · ${port.direction === 'in' ? '输入' : '输出'}`}>
              <span aria-hidden="true">{port.direction === 'in' ? '↦' : '↤'}</span> {portDisplayName(port)}
            </button>
          </li>)}
        </Fragment>;
      })}
    </ul>
  </div>;
}
