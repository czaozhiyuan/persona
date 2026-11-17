import { portKey, type ComponentDefinition, type Connection, type Endpoint, type Instance, type ModuleDefinition, type Params, type Port, type Project, type Transfer, type Link } from '../model/types';

export type ResolvedInstance = Instance & { definition: ComponentDefinition | ModuleDefinition; params: Params; parentId?: string };
export type Arc = { id: string; from: string; to: string; kind: 'mapping' | 'connection' | Transfer['kind']; instanceId?: string; connection?: Connection; transfer?: Transfer };
export type Graph = { instances: ResolvedInstance[]; ports: Map<string, Port>; arcs: Arc[] };

export function resolveInstances(project: Project): ResolvedInstance[] {
  const result: ResolvedInstance[] = [];
  for (const item of project.instances) {
    const definition = [...project.components, ...project.modules].find(d => d.id === item.definitionId);
    if (!definition) throw new Error(`器件定义不存在：${item.definitionId}`);
    if ('transfers' in definition) {
      result.push({ ...item, definition, params: { ...definition.params, ...item.overrides } });
    } else {
      result.push({ ...item, definition, params: item.overrides });
      for (const child of definition.instances) {
        const childDef = project.components.find(d => d.id === child.definitionId);
        if (!childDef) throw new Error('P0 只支持一个模块层级，内部必须引用器件定义');
        const params = { ...childDef.params, ...child.overrides };
        for (const [key, value] of Object.entries(item.overrides)) {
          const targets = definition.overrides[key];
          if (!targets) throw new Error(`模块覆盖参数不合法：${key}`);
          for (const target of targets) if (target.instanceId === child.id) params[target.parameter] = value;
        }
        result.push({ ...child, id: `${item.id}/${child.id}`, name: `${item.name} / ${child.name}`, definition: childDef, params, parentId: item.id });
      }
    }
  }
  return result;
}

export function buildGraph(project: Project, channelId?: string, allChannels = false): Graph {
  if (channelId && !project.channels.some(c => c.id === channelId)) throw new Error(`通道不支持：${channelId}`);
  const instances = resolveInstances(project);
  const ports = new Map<string, Port>(instances.flatMap(item => item.definition.ports.map(p => [`${item.id}:${p.id}`, p] as const)));
  const arcs: Arc[] = [];
  const accepts = (p?: Port) => !!p && (allChannels || !p.channels || (!!channelId && p.channels.includes(channelId)));
  const addConnection = (connection: Connection, prefix = '') => {
    const from = `${prefix}${portKey(connection.from)}`, to = `${prefix}${portKey(connection.to)}`;
    if (accepts(ports.get(from)) && accepts(ports.get(to))) arcs.push({ id: `${prefix}${connection.id}`, from, to, kind: 'connection', connection });
  };
  project.connections.forEach(c => addConnection(c));
  for (const item of instances) {
    if ('transfers' in item.definition) {
      for (const [index, transfer] of item.definition.transfers.entries()) {
        const from = `${item.id}:${transfer.from}`, to = `${item.id}:${transfer.to}`;
        if (!accepts(ports.get(from)) || !accepts(ports.get(to))) continue;
        if (!allChannels && transfer.channels && (!channelId || !transfer.channels.includes(channelId))) continue;
        if (!allChannels && transfer.kind !== 'rf' && typeof item.params.channel === 'string' && item.params.channel !== channelId) continue;
        arcs.push({ id: `${item.id}/transfer${index}`, from, to, kind: transfer.kind, instanceId: item.id, transfer });
      }
    } else {
      for (const mapping of item.definition.mappings) {
        const outer = `${item.id}:${mapping.portId}`, inner = `${item.id}/${portKey(mapping.target)}`;
        if (!accepts(ports.get(outer)) || !accepts(ports.get(inner))) continue;
        const input = ports.get(outer)!.direction === 'in';
        arcs.push({ id: `${item.id}/map-${mapping.portId}`, from: input ? outer : inner, to: input ? inner : outer, kind: 'mapping' });
      }
      item.definition.connections.forEach(c => addConnection(c, `${item.id}/`));
    }
  }
  return { instances, ports, arcs };
}

export function connectionError(project: Project, from: Endpoint, to: Endpoint): string | undefined {
  const instances = resolveInstances(project);
  const a = instances.find(i => i.id === from.instanceId)?.definition.ports.find(p => p.id === from.portId);
  const b = instances.find(i => i.id === to.instanceId)?.definition.ports.find(p => p.id === to.portId);
  if (!a || !b) return '端口不存在';
  if (a.direction !== 'out' || b.direction !== 'in') return '方向不兼容：需要输出 → 输入';
  if (a.type !== b.type) return `类型不兼容：${a.type} → ${b.type}`;
  if (a.channels && b.channels && !a.channels.some(c => b.channels!.includes(c))) return '光通道不兼容';
  if (project.connections.some(c => portKey(c.from) === portKey(from) && portKey(c.to) === portKey(to))) return '此连接已存在';
  return undefined;
}

export type PathResult = { status: 'ok' | 'unreachable' | 'ambiguous'; arcs: Arc[]; message?: string };
export function traceLink(project: Project, link: Link): PathResult {
  const graph = buildGraph(project, link.channelId);
  const start = portKey(link.from), end = portKey(link.to);
  if (!graph.ports.has(start) || !graph.ports.has(end)) return { status: 'unreachable', arcs: [], message: '起止端口不存在' };
  const outgoing = new Map<string, Arc[]>();
  graph.arcs.forEach(a => outgoing.set(a.from, [...outgoing.get(a.from) ?? [], a]));
  const found: Arc[][] = [];
  let visits = 0;
  const walk = (current: string, path: Arc[], visited: Set<string>) => {
    if (found.length > 1) return;
    if (++visits > 20000) throw new Error('路径搜索超过 P0 限额，请缩小路径约束');
    if (current === end) {
      if ((link.viaConnectionIds ?? []).every(id => path.some(a => a.kind === 'connection' && a.id === id))) found.push(path);
      return;
    }
    for (const arc of outgoing.get(current) ?? []) {
      if (!visited.has(arc.to)) walk(arc.to, [...path, arc], new Set([...visited, arc.to]));
    }
  };
  walk(start, [], new Set([start]));
  if (!found.length) return { status: 'unreachable', arcs: [], message: '无法连通：检查端口关系、通道和必经连接约束' };
  if (found.length > 1) return { status: 'ambiguous', arcs: [], message: '路径存在歧义：请添加必经 Connection 约束' };
  return { status: 'ok', arcs: found[0] };
}
