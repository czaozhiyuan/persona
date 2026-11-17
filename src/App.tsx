import { useEffect, useMemo, useRef, useState } from 'react';
import { createExample } from './model/example';
import { endpoint, fixed, type Empirical, type Endpoint, type Project } from './model/types';
import { calculate, evaluate, scan } from './engine/calculate';
import { connectionError, resolveInstances } from './engine/graph';
import { downloadProject, parseProject, serializeProject } from './storage/project';
import { TopologyEditor } from './editors/topology/TopologyEditor';
import { LayoutEditor } from './editors/layout/LayoutEditor';

const display = (n?: number) => n === undefined ? '—' : n.toFixed(1);
const parameterValue = (value: Empirical | string | undefined, channelId?: string) => {
  try { return evaluate(value, 1, channelId); } catch { return undefined; }
};
function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(Number(value.toFixed(1))));
  useEffect(() => setText(String(Number(value.toFixed(1)))), [value]);
  return <label className="field">{label}<input type="number" step="0.1" value={text}
    onBlur={() => setText(String(Number(value.toFixed(1))))}
    onChange={e => { setText(e.target.value); if (e.target.value.trim() && Number.isFinite(e.target.valueAsNumber)) onChange(e.target.valueAsNumber); }} /></label>;
}

export function App() {
  const [project, setProject] = useState<Project>(createExample);
  const [linkId, setLinkId] = useState('link28');
  const [selected, setSelected] = useState('pd28');
  const [view, setView] = useState<'topology' | 'physical'>('topology');
  const [notice, setNotice] = useState('已载入 P0 示例。选择命名 Link 查看路径与经验预算。');
  const [from, setFrom] = useState('input28:rf');
  const [to, setTo] = useState('pcb:RF_IN');
  const fileInput = useRef<HTMLInputElement>(null);
  const items = useMemo(() => resolveInstances(project), [project]);
  const item = items.find(i => i.id === selected);
  const link = project.links.find(l => l.id === linkId);
  const result = link ? calculate(project, link) : undefined;
  const rows = link ? scan(project, link) : [];
  const physical = project.layout.physical[selected];
  const topPosition = project.layout.topology[selected];
  const channel = project.channels.find(c => c.id === link?.channelId);
  const change = (edit: (draft: Project) => void) => setProject(previous => { const draft = structuredClone(previous); edit(draft); return draft; });
  const move = (id: string, x: number, y: number, kind: 'physical' | 'topology') => change(p => {
    if (kind === 'physical') p.layout.physical[id] = { ...p.layout.physical[id], x, y };
    else p.layout.topology[id] = { x, y };
  });
  const connect = (a: Endpoint, b: Endpoint) => {
    const error = a.instanceId.includes('/') || b.instanceId.includes('/') ? '模块内部端口请通过模块定义及对外映射编辑' : connectionError(project, a, b);
    if (error) { setNotice(`连接未建立：${error}`); return; }
    change(p => p.connections.push({ id: `connection-${crypto.randomUUID()}`, from: a, to: b, gainDb: fixed(0) }));
    setNotice(`连接已建立：${a.instanceId}:${a.portId} → ${b.instanceId}:${b.portId}`);
  };
  const topPortOptions = project.instances.flatMap(i => items.find(x => x.id === i.id)!.definition.ports.map(p => <option key={`${i.id}:${p.id}`} value={`${i.id}:${p.id}`}>{i.name} / {p.id} · {p.type} · {p.direction}</option>));
  const selectedModule = project.instances.find(i => i.id === selected && project.modules.some(m => m.id === i.definitionId));
  const modulePower = selectedModule ? parameterValue(selectedModule.overrides.laserPowerDbm ?? project.components.find(c => c.id === 'laser')?.params.powerDbm) : undefined;
  const selectedPower = item && 'size' in item.definition ? item.params.powerDbm : undefined;
  const exportFile = () => { try { downloadProject(project); setNotice('工程已导出：persona-project.json'); } catch (e) { setNotice((e as Error).message); } };
  const attenuation = project.components.find(c => c.id === 'attenuator')?.transfers[0]?.gainDb;
  const moduleMzm = project.modules.find(m => m.id === 'TX_Module')?.instances.find(i => i.id === 'mzm');
  const commonMzm = moduleMzm?.overrides.opticalGainDb ?? project.components.find(c => c.id === 'mzm')?.params.opticalGainDb;

  return <div className="app">
    <header><div className="brand">persona<span>P0 / 技术路线验证</span></div><div className="header-note"><i />离线工程工作台</div>
      <nav><button onClick={() => { setProject(createExample()); setLinkId('link28'); setSelected('pd28'); setNotice('示例工程已重新载入'); }}>载入示例</button>
        <button onClick={() => fileInput.current?.click()}>导入 JSON</button><button className="primary" onClick={exportFile}>导出 JSON ↗</button>
        <button className="quiet" onClick={() => { const p = createExample(); setProject({ ...p, name: '空工程', components: [], modules: [], instances: [], connections: [], links: [], layout: { physical: {}, topology: {} } }); setSelected(''); setLinkId(''); setNotice('工程已清空，可导入 JSON 或重新载入示例'); }}>清空工程</button>
      </nav>
      <input ref={fileInput} aria-label="工程 JSON 文件" data-testid="import-file" type="file" accept=".json,application/json" hidden onChange={async e => {
        const file = e.target.files?.[0]; if (!file) return;
        try { const restored = parseProject(await file.text()); setProject(restored); setLinkId(restored.links[0]?.id ?? ''); setSelected(restored.instances[0]?.id ?? ''); setNotice(`导入成功：${file.name}`); }
        catch (error) { setNotice(`导入失败：${(error as Error).message}`); } finally { e.target.value = ''; }
      }} />
    </header>
    <div className="project-bar"><div><small>PROJECT / 当前工程</small><h1>{project.name}</h1></div><div className="project-count"><b>{project.instances.length}</b> 顶层实例 <span>/</span> <b>{project.connections.length}</b> 连接 <span>/</span> <b>{project.links.length}</b> 命名链路</div></div>
    <div className="workspace">
      <aside className="left-panel">
        <div className="section-caption">01 / 命名链路</div>
        <div className="link-list">{project.links.map(l => <button key={l.id} className={linkId === l.id ? 'selected' : ''} onClick={() => setLinkId(l.id)}><span className="link-dot" />{l.name}<small>{l.channelId ?? 'RF / 经验参数'}</small></button>)}</div>
        <div className="section-caption spaced">02 / 器件实例</div>
        <div className="instance-list">{items.map(i => <button className={selected === i.id ? 'selected' : ''} key={i.id} onClick={() => setSelected(i.id)}><span>{i.parentId ? '↳ ' : ''}{i.name}</span><small>{i.id}</small></button>)}</div>
        <div className="legend"><span className="rf">● RF</span><span className="optical">● OPTICAL</span><span className="power">● DC_POWER</span><span className="control">● CONTROL</span></div>
      </aside>
      <main>
        <div className="view-toolbar"><div className="tabs"><button className={view === 'topology' ? 'active' : ''} onClick={() => setView('topology')}>逻辑拓扑</button><button className={view === 'physical' ? 'active' : ''} onClick={() => setView('physical')}>机箱布局</button></div><span>{view === 'topology' ? '独立逻辑坐标 · 可拖动节点与连接端口' : '独立物理坐标 · 1U / mm'}</span></div>
        <div className="editor-panel">{view === 'topology' ? <TopologyEditor key={project.name + project.instances.length} project={project} selected={selected} highlightedNodes={result?.highlightNodes ?? []} highlightedConnections={result?.highlightConnections ?? []}
          onSelect={setSelected} onMove={(id, x, y) => move(id, x, y, 'topology')} onConnect={connect}
          validate={(a, b) => !a.instanceId.includes('/') && !b.instanceId.includes('/') && !connectionError(project, a, b)}
          onInvalid={() => setNotice('连接未建立：请选择类型、方向及光通道兼容的端口（输出 → 输入）')} />
          : <LayoutEditor project={project} selected={selected} highlighted={result?.highlightNodes ?? []} onSelect={setSelected} onMove={(id, x, y) => move(id, x, y, 'physical')} />}</div>
        <div className="notice" role="status">{notice}</div>
        <section className="connection-panel"><div className="section-caption">连接验证 / 类型与方向规则</div><div className="connection-form">
          <label>起点<select aria-label="连接起点" value={from} onChange={e => setFrom(e.target.value)}>{topPortOptions}</select></label>
          <span>→</span><label>终点<select aria-label="连接终点" value={to} onChange={e => setTo(e.target.value)}>{topPortOptions}</select></label>
          <button onClick={() => { const [a, ap] = from.split(':'), [b, bp] = to.split(':'); connect(endpoint(a, ap), endpoint(b, bp)); }}>建立连接</button>
        </div></section>
        <section className="scan-panel"><div className="section-title"><div><div className="section-caption">RF BUDGET / 1 GHz 固定步长</div><h2>频率扫描</h2></div><span>内部浮点计算 · 显示到 0.1</span></div>
          <table><thead><tr><th>频率 / GHz</th><th>RF 增益 / dB</th><th>光功率 / dBm</th><th>NF / dB</th><th>状态</th></tr></thead><tbody>{rows.map(r => <tr key={r.frequencyGHz}><td>{r.frequencyGHz.toFixed(1)}</td><td>{display(r.rfGainDb)}</td><td>{display(r.opticalPowerDbm)}</td><td>{display(r.nfDb)}</td><td>{r.status === 'ok' ? '有效' : r.status === 'partial' ? '部分有效' : '无法计算'}</td></tr>)}</tbody></table>
          <p className="footnote">PCB → RF 后级示例：折点 1 / 3 / 5 GHz，2 / 4 GHz 线性插值。NF 仅用于纯 RF 级联，光电链路不预测 NF。</p>
        </section>
      </main>
      <aside className="right-panel">
        <section className="budget"><div className="section-caption">03 / 链路预算 · 1.0 GHz</div><h2>{link?.name ?? '请选择 Link'}</h2>
          {link && <label className="field">Link 名称<input aria-label="Link 名称" value={link.name} onChange={e => change(p => { p.links.find(l => l.id === linkId)!.name = e.target.value; })} /></label>}
          <div className="metrics"><div><small>RF 增益 / dB</small><strong data-testid="rf-gain">{display(result?.rfGainDb)}</strong></div><div><small>PD / 光功率 dBm</small><strong data-testid="optical-power">{display(result?.opticalPowerDbm)}</strong></div></div>
          <div className={`result-status ${result?.status === 'ok' ? '' : 'warning'}`} data-testid="calculation-status">{result?.status === 'ok' ? '● 计算有效' : result?.status === 'partial' ? '◐ 部分有效' : '○ 无法计算'}{result?.nfDb !== undefined && ` · NF ${display(result.nfDb)} dB`}</div>
          {channel && <p className="footnote">{channel.label} / {channel.wavelengthNm.toFixed(2)} nm<br />CH28 ↔ CH30 间隔 200 GHz</p>}
          {result?.errors.map((error, i) => <p className="error" key={i}>{error}</p>)}
          {link?.conversion && <><p className="formula">G = G_ref + K × (P_pd − P_ref)</p><div className="field-grid"><NumberField label="K" value={link.conversion.k} onChange={n => change(p => { p.links.find(l => l.id === linkId)!.conversion!.k = n; })} /><NumberField label="固定 P_ref / dBm" value={link.conversion.powerRefDbm} onChange={n => change(p => { p.links.find(l => l.id === linkId)!.conversion!.powerRefDbm = n; })} /></div><p className="footnote">G_ref = {link.conversion.gainRefDb.toFixed(1)} dB。参考光功率不会随重算更新。</p></>}
          {attenuation?.kind === 'channel' && channel && channel.id in attenuation.values && <><NumberField label="当前通道附加光增益 / dB" value={attenuation.values[channel.id]} onChange={n => change(p => { const t = p.components.find(c => c.id === 'attenuator')!.transfers[0].gainDb!; if (t.kind === 'channel') t.values[channel.id] = n; })} />
            <div className="presets">{[-3, 0, 3].map(gain => <button key={gain} onClick={() => change(p => { const t = p.components.find(c => c.id === 'attenuator')!.transfers[0].gainDb!; if (t.kind === 'channel') t.values[channel.id] = gain; })}>{gain > 0 ? '+' : ''}{gain} dB</button>)}</div></>}
          <details><summary>路径及逐级摘要（{result?.path.length ?? 0} 段）</summary><ol className="path-list">{result?.stages.map((s, i) => <li key={i}><b>{s.label}</b><span>{s.kind} · G {display(s.gainDb)} dB · P {display(s.opticalPowerDbm)} dBm</span>{s.error && <em>{s.error}</em>}</li>)}</ol></details>
        </section>
        <section className="properties"><div className="section-caption">04 / 实例属性</div><select aria-label="选中实例" value={selected} onChange={e => setSelected(e.target.value)}>{items.map(i => <option key={i.id} value={i.id}>{i.name} / {i.id}</option>)}</select>
          {item && <><p className="id-line">ID / {item.id}</p>{!item.parentId ? <label className="field">实例名称<input aria-label="实例名称" value={item.name} onChange={e => change(p => { p.instances.find(i => i.id === selected)!.name = e.target.value; })} /></label> : <p className="footnote">内部实例引用共享模块定义；独立参数通过所属 TX_Module 覆盖。</p>}
            {physical && <><div className="field-grid"><NumberField label="物理 X / mm" value={physical.x} onChange={n => move(selected, n, physical.y, 'physical')} /><NumberField label="物理 Y / mm" value={physical.y} onChange={n => move(selected, physical.x, n, 'physical')} /></div><button className="wide" onClick={() => change(p => { p.layout.physical[selected].rotation = (physical.rotation + 90) % 360; })}>旋转 90°（当前 {physical.rotation}°）</button></>}
            {topPosition && <div className="field-grid"><NumberField label="逻辑 X" value={topPosition.x} onChange={n => move(selected, n, topPosition.y, 'topology')} /><NumberField label="逻辑 Y" value={topPosition.y} onChange={n => move(selected, topPosition.x, n, 'topology')} /></div>}
            {selectedPower && <p className="footnote">激光器有效输出功率：{display(parameterValue(selectedPower, typeof item.params.channel === 'string' ? item.params.channel : undefined))} dBm</p>}
            {selectedModule && <>{modulePower !== undefined ? <NumberField label="本实例激光功率覆盖 / dBm" value={modulePower} onChange={n => change(p => { p.instances.find(i => i.id === selected)!.overrides.laserPowerDbm = fixed(n); })} /> : <p className="error">激光功率无法计算：请补全 JSON 中的必要参数。</p>}
              <label className="field">本实例通道覆盖<select aria-label="模块通道" value={typeof selectedModule.overrides.channel === 'string' ? selectedModule.overrides.channel : 'DWDM_CH28'} onChange={e => change(p => { p.instances.find(i => i.id === selected)!.overrides.channel = e.target.value; })}>{project.channels.filter(c => c.family === 'DWDM_100G').map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label></>}
            <div className="port-summary">{item.definition.ports.map(p => <span key={p.id}>{p.id}<small>{p.type} / {p.direction}</small></span>)}</div></>}
        </section>
        {commonMzm && <section className="shared-definition"><div className="section-caption">共享定义 / TX_Module</div>{parameterValue(commonMzm) !== undefined ? <NumberField label="共同 MZM 光增益 / dB" value={parameterValue(commonMzm)!} onChange={n => change(p => { p.modules.find(m => m.id === 'TX_Module')!.instances.find(i => i.id === 'mzm')!.overrides.opticalGainDb = fixed(n); })} /> : <p className="error">共同 MZM 参数在当前频率下无法计算，请补全 JSON。</p>}<p className="footnote">两个实例同时生效；实例激光功率与通道覆盖保持独立。</p></section>}
      </aside>
    </div><footer>persona / P0 技术原型 <span>JSON 是工程存储 · Connection / Link / Channel 独立建模</span><span>{serializeProject(project).length.toLocaleString()} 字符工程数据</span></footer>
  </div>;
}
