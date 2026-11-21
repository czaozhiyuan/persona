import type { EndpointRef, InstancePath, Project } from '../../../model/v1/types';
import type { ReactNode } from 'react';

export function EndpointLocation({ endpoint, label, locate }: {
  endpoint: EndpointRef; label: string; locate?: (endpoint: EndpointRef) => void;
}) {
  return locate ? <button type="button" className="v1-budget-locate" title="在框图定位此端口"
    onClick={() => locate(endpoint)}>{label}</button> : label;
}

export function BudgetDock({ title, collapsed, enlarged, toggle, enlarge, close, children }: {
  title: string; collapsed: boolean; enlarged: boolean; toggle: () => void; enlarge: () => void;
  close: () => void; children: ReactNode;
}) {
  return <section className="v1-budget-dock" aria-label={title}>
    <header>
      <button type="button" aria-expanded={!collapsed} aria-controls="v1-budget-content" onClick={toggle}>{title}</button>
      {!collapsed && <button type="button" aria-pressed={enlarged} onClick={enlarge}>{enlarged ? '还原高度' : '放大查看'}</button>}
      <button type="button" onClick={close}>关闭计算面板</button>
    </header>
    <div id="v1-budget-content" hidden={collapsed}>{children}</div>
  </section>;
}

export function enclosureContains(project: Project, scope: InstancePath) {
  const key = JSON.stringify(scope);
  const physical = new Map(project.layout?.physical?.map(item => [JSON.stringify(item.instancePath), item.enclosurePath]));
  return (path: InstancePath) => {
    const visited = new Set<string>();
    let current = path;
    while (true) {
      const id = JSON.stringify(current);
      if (id === key) return true;
      if (!current.length || visited.has(id)) return false;
      visited.add(id);
      current = physical.get(id) ?? current.slice(0, -1);
    }
  };
}
