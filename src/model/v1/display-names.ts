import type { ComponentDefinition, ModuleDefinition, PortDefinition, PortType, Project } from './types';

export const portTypeLabels = {
  RF: '射频',
  OPTICAL: '光信号',
  DC_POWER: '直流供电',
  CONTROL: '控制',
} satisfies Record<PortType, string>;

export function numberedName<T>(items: readonly T[], item: T, label: (item: T) => string): string {
  const name = label(item);
  const matches = items.filter(other => label(other) === name);
  return matches.length > 1 ? `${name}（${matches.indexOf(item) + 1}）` : name;
}

type DisplayPort = Pick<PortDefinition, 'id' | 'name'> & Partial<Pick<PortDefinition, 'type' | 'direction'>>;

const uuid = /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?:_\d+)?/gi;

function portFallback({ type, direction }: DisplayPort) {
  return type && direction ? portTypeLabels[type] + (direction === 'in' ? '输入' : '输出') : '未命名端口';
}

export function editablePortName(port: DisplayPort): string {
  return port.name?.replace(uuid, portFallback(port)) ?? '';
}

export function portDisplayName(port: DisplayPort, includeCode = false, peers?: readonly DisplayPort[]): string {
  function label(p: DisplayPort) {
    const { id } = p;
    const name = editablePortName(p);
    const code = /^[A-Z][A-Z0-9_]{0,31}$/.test(id) ? id : undefined;
    return name ? (includeCode && code && code !== name ? `${name}（${code}）` : name) : code ?? portFallback(p);
  }
  return peers ? numberedName(peers, port, label) : label(port);
}

/** A scoped label index for shared-definition changes and diagnostic references. */
export function definitionLabels(definition: ModuleDefinition | ComponentDefinition, project: Project) {
  const names = new Map<string, string>();
  for (const item of [...project.moduleDefinitions, ...project.componentDefinitions]) names.set(item.id, item.name);
  if (definition.kind === 'module') {
    for (const child of definition.instances) names.set(child.id, numberedName(definition.instances, child, i => i.name));
    for (const [i, wire] of (definition.connections ?? []).entries()) names.set(wire.id, `连接 ${i + 1}`);
    for (const [i, bundle] of (definition.cableBundles ?? []).entries()) {
      names.set(bundle.id, `线缆 ${i + 1}`);
      for (const core of bundle.cores) names.set(core.id, `纤芯 A:${core.a.pin} / B:${core.b.pin}`);
    }
  } else {
    for (const state of definition.switchStates ?? []) names.set(state.id, state.name);
  }
  for (const p of definition.ports) names.set(p.id, portDisplayName(p, false, definition.ports));
  const parameters = definition.parameters ?? [];
  for (const p of parameters) names.set(p.id, numberedName(parameters, p, item => item.name));
  return names;
}

export function readableError(message: string, project?: Project): string {
  const definitions = new Map([...(project?.moduleDefinitions ?? []), ...(project?.componentDefinitions ?? [])].map(d => [d.id, d]));
  const ownerId = /(?:定义|模块|器件|机箱|光开关)「([^」]+)」/.exec(message)?.[1];
  const owner = ownerId && definitions.get(ownerId);
  const labels = owner && project ? definitionLabels(owner, project) : undefined;
  const missing = '未找到的对象或端口';
  const lookup = (id: string) => labels?.get(id) ?? definitions.get(id)?.name
    ?? project?.namedLinks?.find(link => link.id === id)?.name ?? missing;
  if (!message.startsWith('$.project:')) return message.replace(uuid, lookup);

  // Invalid snapshots may contain cycles. Follow only the finite path reported by the validator.
  function describePath(serialized: string) {
    if (!project) return missing;
    let path: string[];
    try { path = JSON.parse(serialized); } catch { return missing; }
    let def = definitions.get(project.rootModuleDefinitionId);
    const names: string[] = [];
    for (const [i, id] of path.entries()) {
      const child = def?.kind === 'module' ? def.instances.find(item => item.id === id) : undefined;
      if (!child) return [...names, '未找到的对象'].join(' / ');
      const key = JSON.stringify(path.slice(0, i + 1));
      names.push(project.instanceSettings?.find(s => JSON.stringify(s.instancePath) === key)?.name ?? child.name);
      def = definitions.get(child.definitionId);
    }
    return names.join(' / ') || def?.name || missing;
  }
  return message.replace(/\[(?:"(?:\\.|[^"\\])*"(?:,"(?:\\.|[^"\\])*")*)?\]/g, describePath)
    .replace(/(循环引用： )(.+)$/, (_, prefix: string, cycle: string) =>
      prefix + cycle.split(' -> ').map(lookup).join(' → '))
    .replace(/(定义|模块|器件|机箱|光开关|状态|实例|链路|必经连接|连接|端口|线缆束|纤芯|参数映射|参数|ID)「([^」]+)」/g,
      (_, kind: string, id: string) => `${kind}「${lookup(id)}」`)
    .replace(uuid, lookup);
}
