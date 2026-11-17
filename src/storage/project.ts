import { CHANNELS } from '../model/channels';
import { resolveInstances } from '../engine/graph';
import { portKey, type Empirical, type Port, type Project } from '../model/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`工程无效：${message}`);
}
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const id = (value: unknown) => typeof value === 'string' && /^[\w.-]+$/.test(value);
function unique(values: string[], label: string) {
  assert(new Set(values).size === values.length, `${label} ID 重复`);
}

export function validateProject(project: Project): void {
  assert(project && project.schemaVersion === 1, '仅支持 schemaVersion 1，不做版本迁移');
  assert(typeof project.name === 'string', '缺少工程名称');
  for (const key of ['channels', 'components', 'modules', 'instances', 'connections', 'links'] as const) assert(Array.isArray(project[key]), `缺少 ${key} 数组`);
  assert(project.layout?.physical && project.layout?.topology, '缺少双视图坐标');
  assert(project.chassis && Object.values(project.chassis).every(n => finite(n) && n > 0) && ['width', 'depth', 'height'].every(k => k in project.chassis), '机箱尺寸须为正数 mm');
  unique(project.channels.map(c => c.id), '通道');
  for (const c of project.channels) {
    const expected = CHANNELS.find(v => v.id === c.id);
    assert(expected && typeof c.label === 'string' && c.family === expected.family && finite(c.wavelengthNm) && Math.abs(c.wavelengthNm - expected.wavelengthNm) < 0.01 && c.frequencyTHz === expected.frequencyTHz, `通道映射错误：${c.id}`);
  }
  const channelIds = new Set(project.channels.map(c => c.id));
  const channels = (values?: string[]) => { if (values) assert(Array.isArray(values) && values.every(c => channelIds.has(c)), '引用不支持的通道'); };
  const empirical = (value: Empirical) => {
    assert(value && typeof value === 'object', '经验参数结构错误');
    if (value.kind === 'fixed') assert(finite(value.value), '固定参数不是有限数值');
    else if (value.kind === 'rf') {
      assert(Array.isArray(value.points) && value.points.length > 0, 'RF 折点表为空');
      value.points.forEach((p, i) => assert(Array.isArray(p) && p.length === 2 && p.every(finite) && (i === 0 || p[0] > value.points[i - 1][0]), 'RF 折点须为有限数值且频率严格递增'));
    } else if (value.kind === 'channel') {
      assert(value.values && typeof value.values === 'object', '缺少通道表');
      Object.entries(value.values).forEach(([c, n]) => assert(channelIds.has(c) && finite(n), '通道表包含非法通道或数值'));
    } else assert(false, '未知经验参数类型');
  };
  const params = (values: Project['instances'][number]['overrides']) => {
    assert(values && typeof values === 'object' && !Array.isArray(values), '缺少参数对象');
    Object.entries(values).forEach(([k, v]) => {
      if (k === 'channel') assert(typeof v === 'string' && channelIds.has(v), '通道参数必须是合法枚举字符串');
      else { assert(typeof v !== 'string', '数值参数须使用经验参数结构'); empirical(v); }
    });
  };
  const ports = (values: Port[]) => {
    assert(Array.isArray(values), '缺少端口数组'); unique(values.map(p => p.id), '端口');
    values.forEach(p => { assert(id(p.id) && ['RF', 'OPTICAL', 'DC_POWER', 'CONTROL'].includes(p.type) && ['in', 'out'].includes(p.direction), '端口定义错误'); channels(p.channels); });
  };
  unique([...project.components, ...project.modules].map(d => d.id), '定义');
  for (const d of project.components) {
    assert(id(d.id) && typeof d.name === 'string', '器件定义 ID/名称错误'); ports(d.ports); params(d.params);
    assert(d.size && finite(d.size.width) && finite(d.size.depth) && d.size.width > 0 && d.size.depth > 0, '器件尺寸无效');
    assert(Array.isArray(d.transfers), '缺少经验传输数组');
    for (const t of d.transfers) {
      const a = d.ports.find(p => p.id === t.from), b = d.ports.find(p => p.id === t.to);
      assert(a?.direction === 'in' && b?.direction === 'out', '内部传输须为输入 → 输出');
      const pairs = { rf: ['RF', 'RF'], optical: ['OPTICAL', 'OPTICAL'], eo: ['RF', 'OPTICAL'], oe: ['OPTICAL', 'RF'] };
      assert(t.kind in pairs && a.type === pairs[t.kind][0] && b.type === pairs[t.kind][1], '传输类型与端口不符');
      if (t.kind === 'eo') assert(d.ports.some(p => p.id === t.supplyPort && p.type === 'OPTICAL' && p.direction === 'in'), 'EO 缺少供光端口');
      if (t.gainDb !== undefined) empirical(t.gainDb);
      if (t.nfDb !== undefined) empirical(t.nfDb);
      channels(t.channels);
    }
  }
  const definitions = [...project.components, ...project.modules];
  const instances = (items: Project['instances'], internal = false) => {
    assert(Array.isArray(items), '缺少实例数组'); unique(items.map(i => i.id), '实例');
    items.forEach(i => {
      assert(id(i.id) && typeof i.name === 'string', '实例 ID/名称无效'); params(i.overrides);
      const d = (internal ? project.components : definitions).find(d => d.id === i.definitionId);
      assert(d, `定义不存在或超出一个模块层级：${i.definitionId}`);
      if ('transfers' in d) Object.entries(i.overrides).forEach(([k, v]) => assert(k in d.params && typeof v === typeof d.params[k], `非法器件覆盖参数：${k}`));
      else Object.keys(i.overrides).forEach(k => assert(k in d.overrides, `非法模块覆盖参数：${k}`));
    });
  };
  const connections = (items: Project['connections'], children: Project['instances']) => {
    assert(Array.isArray(items), '缺少连接数组'); unique(items.map(c => c.id), '连接');
    const pairKeys: string[] = [];
    items.forEach(c => {
      assert(id(c.id), '连接 ID 无效'); empirical(c.gainDb);
      const getPort = (p: typeof c.from) => {
        const i = children.find(i => i.id === p?.instanceId);
        return definitions.find(d => d.id === i?.definitionId)?.ports.find(v => v.id === p.portId);
      };
      const a = getPort(c.from), b = getPort(c.to);
      assert(a && b && a.direction === 'out' && b.direction === 'in' && a.type === b.type, `连接端口类型或方向无效：${c.id}`);
      assert(!a.channels || !b.channels || a.channels.some(ch => b.channels!.includes(ch)), `连接通道不兼容：${c.id}`);
      pairKeys.push(`${portKey(c.from)}>${portKey(c.to)}`);
    });
    unique(pairKeys, '连接端点对');
  };
  for (const m of project.modules) {
    assert(id(m.id) && typeof m.name === 'string', '模块 ID/名称无效'); ports(m.ports); instances(m.instances, true); connections(m.connections, m.instances);
    assert(Array.isArray(m.mappings) && m.overrides && typeof m.overrides === 'object', '缺少模块映射/覆盖声明');
    unique(m.mappings.map(v => v.portId), '模块映射');
    for (const p of m.ports) {
      const mapping = m.mappings.find(v => v.portId === p.id);
      const child = m.instances.find(i => i.id === mapping?.target.instanceId);
      const inner = project.components.find(d => d.id === child?.definitionId)?.ports.find(v => v.id === mapping?.target.portId);
      assert(inner && inner.type === p.type && inner.direction === p.direction, '模块端口映射无效');
    }
    Object.values(m.overrides).forEach(targets => {
      assert(Array.isArray(targets) && targets.length > 0, '模块覆盖目标为空');
      targets.forEach(t => {
        const child = m.instances.find(i => i.id === t.instanceId);
        assert(child && t.parameter in project.components.find(d => d.id === child.definitionId)!.params, '模块覆盖目标无效');
      });
    });
  }
  instances(project.instances); connections(project.connections, project.instances);
  const resolved = resolveInstances(project);
  for (const i of resolved) params(i.params);
  for (const [view, positions] of Object.entries(project.layout)) {
    assert(['physical', 'topology'].includes(view), '未知视图');
    for (const [key, position] of Object.entries(positions)) {
      assert(resolved.some(i => i.id === key), `坐标引用未知实例：${key}`);
      assert(finite(position.x) && finite(position.y), '坐标不是有限数值');
      if (view === 'physical') assert('rotation' in position && finite(position.rotation) && position.rotation % 90 === 0, '旋转须为 90° 倍数');
    }
  }
  unique(project.links.map(l => l.id), 'Link');
  for (const l of project.links) {
    assert(id(l.id) && typeof l.name === 'string', 'Link ID/名称无效');
    for (const e of [l.from, l.to]) assert(resolved.find(i => i.id === e?.instanceId)?.definition.ports.some(p => p.id === e.portId), 'Link 端点不存在');
    if (l.channelId !== undefined) assert(channelIds.has(l.channelId), 'Link 通道不支持');
    if (l.viaConnectionIds) assert(Array.isArray(l.viaConnectionIds) && l.viaConnectionIds.every(id => project.connections.some(c => c.id === id)), '必经连接不存在');
    if (l.conversion) assert(['gainRefDb', 'powerRefDbm', 'k'].every(k => finite(l.conversion![k as keyof typeof l.conversion])), '转换基准缺失或无效');
  }
}

export function parseProject(json: string): Project {
  const project = JSON.parse(json) as Project;
  validateProject(project);
  return project;
}
export function serializeProject(project: Project): string {
  validateProject(project);
  return JSON.stringify(project, null, 2) + '\n';
}
export function downloadProject(project: Project) {
  const url = URL.createObjectURL(new Blob([serializeProject(project)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = 'persona-project.json'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
