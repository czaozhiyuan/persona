import { useState } from 'react';
import type { PathResult } from '../../../engine/v1/path-resolver';
import { signalPortKey } from '../../../engine/v1/signal-graph';
import { resolveOpticalChannel } from '../../../model/v1/channels';
import type { ConversionBinding, NamedLink } from '../../../model/v1/topology';
import type { Project } from '../../../model/v1/types';
import type { ProjectStore } from '../../../state/v1/project-store';
import { ChannelField } from '../properties/channel-field';
import { conversionKey, requiredEdgeKey, showEndpoint } from './link-options';
import type { LinkOptions, Option } from './link-options';
import './link-editor.css';

type Props = {
  store: ProjectStore;
  project: Project;
  options: LinkOptions;
  selected?: NamedLink;
  result?: PathResult;
  sourceKeys: readonly string[];
  setSources: (keys: readonly string[]) => void;
};

function Choice<T>({ name, title, options, value, required }: {
  name: string; title: string; options: readonly Option<T>[]; value?: string; required?: boolean;
}) {
  return <label>{title}<select name={name} required={required} defaultValue={value ?? ''}>
    <option value="">{required ? '请选择' : '未设置'}</option>
    {options.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
  </select></label>;
}

const statusLabels = {
  resolved: '路径已解析', incomplete: '未完成', invalid_reference: '引用无效', unreachable: '不可达',
  ambiguous: '路径歧义', feedback_loop: '存在反馈环', search_limit: '达到搜索上限',
};
const supplyLabels = { resolved: '供光路径已解析', missing: '供光缺失', ambiguous: '供光歧义', feedback_loop: '供光反馈环', search_limit: '供光搜索达到上限' };

function Diagnostics({ result }: { result: PathResult }) {
  return <div className="v1-link-diagnostics" role="status" data-path-status={result.status}>
    <strong>{statusLabels[result.status]}</strong>
    {result.status !== 'resolved' && <p>
      {result.status === 'incomplete' ? (result.endpoint ? '缺少内部端口映射' : '缺少起点或终点') : result.reason}
      {result.endpoint && ` · ${showEndpoint(result.endpoint)}`}
    </p>}
    {result.trace && <details>
      <summary>主路径 · {result.trace.edges.length} 条边</summary>
      <ol>{result.trace.steps.map((step, index) => <li key={index}>
        {showEndpoint(step.port.ref)}{step.channelIds?.length ? ` · ${step.channelIds.join(' / ')}` : ''}
      </li>)}</ol>
    </details>}
    {!!result.trace?.supplies.length && <ul>{result.trace.supplies.map(supply =>
      <li key={supply.edgeIndex}>{supplyLabels[supply.status]} · {showEndpoint(supply.endpoint)}</li>)}</ul>}
  </div>;
}

export function LinkEditor({ store, project, options, selected, result, sourceKeys, setSources }: Props) {
  const [error, setError] = useState('');
  const [bindingId, setBindingId] = useState('');
  const binding = selected?.conversionBindings?.find(item => item.id === bindingId);
  const bindings = selected?.conversionBindings ?? [];
  const profiles = project.conversionProfiles ?? [];

  function commitLink(link: NamedLink) {
    const edit = store.commit(draft => ({
      ...draft,
      namedLinks: draft.namedLinks?.some(item => item.id === link.id)
        ? draft.namedLinks.map(item => item.id === link.id ? link : item)
        : [...(draft.namedLinks ?? []), link],
    }));
    setError(edit.ok ? '' : edit.message);
    if (edit.ok) store.selectLink(link.id);
    return edit.ok;
  }

  return <section className="panel v1-links" aria-labelledby="v1-links-title">
    <div className="v1-links-header">
      <h2 id="v1-links-title">命名链路</h2>
      <label htmlFor="link-selection">当前 Link</label>
      <select id="link-selection" value={selected?.id ?? ''} onChange={event => {
        store.selectLink(event.target.value || undefined);
        setError('');
      }}>
        <option value="">新建 Link</option>
        {project.namedLinks?.map(item => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}
      </select>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {result && <Diagnostics result={result} />}
    <details open={!selected || undefined}>
      <summary>Link 设置</summary>
      <form key={JSON.stringify(selected ?? null)} onSubmit={event => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const name = String(fields.get('name') ?? '').trim();
        if (!name) { setError('Link 名称不能为空。'); return; }
        const endpoint = (key: string) => options.endpoints.find(item => item.key === fields.get(key))?.value;
        const via = fields.getAll('via').map(key => options.via.find(item => item.key === key)?.value);
        const rawChannel = String(fields.get('channel') ?? '');
        const channel = rawChannel ? resolveOpticalChannel(rawChannel) : undefined;
        if ((fields.get('from') && !endpoint('from')) || (fields.get('to') && !endpoint('to'))
          || via.some(item => !item) || (rawChannel && !channel)) {
          setError('端口、必经边或通道已失效，请重新选择。');
          return;
        }
        const required = via.filter(item => item !== undefined);
        commitLink({ ...selected, id: selected?.id ?? crypto.randomUUID(), name, from: endpoint('from'), to: endpoint('to'),
          channelId: channel?.id, via: required.length ? required : undefined });
      }}>
        <label>Link 名称<input name="name" required defaultValue={selected?.name} /></label>
        <div className="v1-link-fields">
          <Choice title="起点" name="from" options={options.endpoints} value={selected?.from && signalPortKey(selected.from)} />
          <Choice title="终点" name="to" options={options.endpoints} value={selected?.to && signalPortKey(selected.to)} />
          <ChannelField label="离散光通道（可选）" name="channel" value={selected?.channelId} />
          <label>必经连接或纤芯（可多选）<select name="via" multiple size={4} defaultValue={selected?.via?.map(requiredEdgeKey) ?? []}>
            {options.via.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select></label>
        </div>
        <button type="submit">{selected ? '保存 Link' : '创建 Link'}</button>
      </form>
    </details>
    {selected && <>
      <details>
        <summary>供光查询</summary>
        <label>供光来源（可多选）<select name="opticalSources" multiple size={4} value={[...sourceKeys]}
          onChange={event => setSources([...event.currentTarget.selectedOptions].map(option => option.value))}>
          {options.opticalSources.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select></label>
      </details>
      <details>
        <summary>EO/OE 标定绑定</summary>
        <label>工程内绑定<select value={binding?.id ?? ''} onChange={event => { setBindingId(event.target.value); setError(''); }}>
          <option value="">新建绑定</option>
          {bindings.map(item => <option key={item.id} value={item.id}>
            {profiles.find(profile => profile.id === item.profileId)?.name} · {showEndpoint({ instancePath: item.eo.instancePath, portId: item.eo.fromPortId })}
          </option>)}
        </select></label>
        {bindings.length > 0 && <ul className="v1-binding-matches">{bindings.map(item => {
          const match = result?.trace?.bindings.find(candidate => candidate.binding.id === item.id);
          return <li key={item.id}>{profiles.find(profile => profile.id === item.profileId)?.name} · {
            match?.matched ? '已匹配当前路径' : result?.trace ? '当前路径未匹配' : '等待路径解析'
          }</li>;
        })}</ul>}
        <form key={JSON.stringify(binding ?? null)} onSubmit={event => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          const profile = profiles.find(item => item.id === fields.get('profile'));
          const eo = options.eo.find(item => item.key === fields.get('eo'))?.value;
          const oe = options.oe.find(item => item.key === fields.get('oe'))?.value;
          if (!profile || !eo || !oe) { setError('请选择有效 Profile 和对应类型的 EO/OE 边界。'); return; }
          const next: ConversionBinding = { ...binding, id: binding?.id ?? crypto.randomUUID(), profileId: profile.id, eo, oe };
          const conversionBindings = binding ? bindings.map(item => item.id === binding.id ? next : item) : [...bindings, next];
          if (commitLink({ ...selected, conversionBindings })) setBindingId(next.id);
        }}>
          <div className="v1-link-fields">
            <Choice title="标定 Profile" name="profile" required
              options={profiles.map(item => ({ key: item.id, label: item.name, value: item }))}
              value={binding?.profileId} />
            <Choice title="EO 边界" name="eo" options={options.eo} required value={binding && conversionKey(binding.eo)} />
            <Choice title="OE 边界" name="oe" options={options.oe} required value={binding && conversionKey(binding.oe)} />
          </div>
          {!profiles.length && <p>请先在工程标定 Profile 中新建标定。</p>}
          <button type="submit" disabled={!profiles.length || !options.eo.length || !options.oe.length}>{binding ? '保存绑定' : '创建绑定'}</button>
          {binding && <button type="button" onClick={() => {
            if (commitLink({ ...selected, conversionBindings: bindings.filter(item => item.id !== binding.id) })) setBindingId('');
          }}>移除绑定</button>}
        </form>
      </details>
    </>}
  </section>;
}
