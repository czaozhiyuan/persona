import { useId, useState } from 'react';
import { resolveOpticalChannel } from '../../../model/v1/channels';
import type { ComponentDefinition, PortFlow } from '../../../model/v1/types';
import { validateWdm, wdmPort, withWdmPorts } from '../../../model/v1/wdm';
import type { ProjectStore } from '../../../state/v1/project-store';
import { planPortDeletion } from '../../../state/v1/topology-edits';
import './wdm-configuration.css';

const presets = [...Array.from({ length: 18 }, (_, i) => 'CWDM_' + (1271 + 20 * i)), 'DWDM_CH28', 'DWDM_CH30'];

export function WdmConfiguration({ definition, template = false, save, cancel }: {
  definition: ComponentDefinition; template?: boolean; save: (next: ComponentDefinition) => void; cancel: () => void;
}) {
  const grid = useId();
  const [rows, setRows] = useState(() => definition.ports.filter(port => port.id !== 'COM').map(port => ({
    id: port.id, direction: port.direction as PortFlow, channel: String(port.channelIds![0]), name: port.name ?? '',
  })));
  const [error, setError] = useState('');
  const loss = definition.parameters?.find(parameter => parameter.id === 'insertionLoss');
  const initialLoss = loss?.kind === 'numeric' && loss.defaultValue?.kind === 'fixed' ? loss.defaultValue.value : '';
  function update(id: string, values: Partial<typeof rows[number]>) {
    setError('');
    setRows(rows.map(row => row.id === id ? { ...row, ...values } : row));
  }
  return <form className="v1-wdm-config" onSubmit={event => {
    event.preventDefault();
    try {
      const data = new FormData(event.currentTarget);
      const ports = rows.map(row => {
        const channel = resolveOpticalChannel(row.channel.trim());
        if (!channel || channel.family === 'MM850') throw new Error('请选择标准 CWDM 或 DWDM 通道：' + row.channel);
        const original = definition.ports.find(port => port.id === row.id);
        return { ...original, ...wdmPort(row.id, channel.id, row.direction), name: row.name.trim() || channel.id,
          inputRating: row.direction === 'in' ? original?.inputRating : undefined };
      });
      let next = withWdmPorts(definition, [definition.ports.find(port => port.id === 'COM')!, ...ports]);
      if (template) {
        const name = String(data.get('name')).trim();
        if (!name) throw new Error('请填写模板名称。');
        const value = String(data.get('insertionLoss')).trim();
        next = { ...next, name, parameters: next.parameters?.map(p => p.id === 'insertionLoss' && p.kind === 'numeric'
          ? { ...p, defaultValue: value ? { kind: 'fixed', value: Number(value) } : undefined } : p) };
      }
      validateWdm(next);
      save(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }}>
    {template && <>
      <label>模板名称<input name="name" defaultValue={definition.name} required /></label>
      <label>统一通道插损 (dB)<input name="insertionLoss" type="number" step="any" min="0" defaultValue={initialLoss} /></label>
    </>}
    <h4>波长端口（{rows.length} 路）</h4>
    <p>顶部 COM 双向共用。输入波长从本机发往 COM，输出波长由 COM 接收。</p>
    {!template && <p>修改通道会保留端口连接并重新计算路径。修改方向须与已有连接兼容；删除端口时可确认解绑范围。</p>}
    <datalist id={grid}>{[...new Set([...presets, ...definition.ports.flatMap(port => port.channelIds ?? [])])]
      .map(channel => <option key={channel} value={channel} />)}</datalist>
    {rows.map((row, index) => <fieldset key={row.id} data-wdm-port={row.id}><legend title={'稳定端口 ID：' + row.id}>波长端口 {index + 1}</legend>
      <label>端口名称<input value={row.name} placeholder={row.channel} onChange={event => update(row.id, { name: event.target.value })} /></label>
      <label>光通道<input list={grid} required value={row.channel} placeholder="CWDM_1311 或 DWDM_CH31" onChange={event => {
        const channel = event.target.value;
        update(row.id, { channel, ...(row.name === row.channel && { name: channel }) });
      }} /></label>
      <label>本机方向<select value={row.direction} onChange={event => update(row.id, { direction: event.target.value as PortFlow })}>
        <option value="in">输入 → COM</option><option value="out">COM → 输出</option>
      </select></label>
      <button type="button" onClick={() => { setError(''); setRows(rows.filter(item => item.id !== row.id)); }}>移除</button>
    </fieldset>)}
    <button type="button" onClick={() => setRows([...rows, { id: crypto.randomUUID(), name: '',
      channel: presets.find(id => rows.every(row => row.channel !== id)) ?? '', direction: 'in' }])}>＋ 添加波长端口</button>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="actions"><button type="submit" className="primary">{template ? '保存到器件库' : '保存波长配置'}</button>
      <button type="button" onClick={cancel}>{template ? '取消草稿' : '取消'}</button></div>
  </form>;
}

export function WdmPortDialog({ definition, name, locations, store, close }: {
  definition: ComponentDefinition; name: string; locations: readonly string[]; store: ProjectStore; close: () => void;
}) {
  const [base] = useState(() => store.getSnapshot().project);
  return <dialog className="v1-topology-dialog v1-wdm-dialog" aria-label={'WDM 波长配置 · ' + name}
    ref={dialog => { if (dialog && !dialog.open) dialog.showModal(); }} onCancel={close}>
    <h3>WDM 波长配置 · {name}</h3>
    {locations.length > 0 && <p>共享定义 · 端口变更会应用到 {locations.join('、')}。</p>}
    <WdmConfiguration definition={definition} cancel={close} save={next => {
      if (store.getSnapshot().project !== base) throw new Error('工程已变化，请重新打开波长配置。');
      let project = base;
      const impacts: string[] = [];
      for (const port of definition.ports) {
        if (next.ports.some(p => p.id === port.id)) continue;
        const plan = planPortDeletion(project, definition.id, port.id)!;
        impacts.push(...plan.impacts.map(item => item.kind + ' · ' + item.name));
        project = plan.project;
      }
      if (impacts.length && !window.confirm('确认删除端口并解绑？\n' + impacts.join('\n'))) return;
      if (JSON.stringify(next) !== JSON.stringify(definition)) {
        const result = store.commit(() => ({ ...project,
          componentDefinitions: project.componentDefinitions.map(d => d.id === next.id ? next : d) }));
        if (!result.ok) throw new Error(result.message);
      }
      close();
    }} />
  </dialog>;
}
