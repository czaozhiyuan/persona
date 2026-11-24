import type { EndpointRef, InstancePath, Project } from '../../../model/v1/types';

export function EndpointLocation({ endpoint, label, locate }: {
  endpoint: EndpointRef; label: string; locate?: (endpoint: EndpointRef) => void;
}) {
  return locate ? <button type="button" className="v1-budget-locate" title="在框图定位此端口"
    onClick={() => locate(endpoint)}>{label}</button> : label;
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
