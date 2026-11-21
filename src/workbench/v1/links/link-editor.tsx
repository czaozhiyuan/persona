import { useState } from 'react';
import type { createLinkBudget } from '../../../engine/v1/link-budget';
import type { OpticalBudget } from '../../../engine/v1/optical-budget';
import type { PathResult } from '../../../engine/v1/path-resolver';
import { signalPortKey } from '../../../engine/v1/signal-graph';
import { resolveOpticalChannel } from '../../../model/v1/channels';
import type { ConversionBinding, LinkTrial, NamedLink } from '../../../model/v1/topology';
import type { EndpointRef, Project } from '../../../model/v1/types';
import type { ProjectStore } from '../../../state/v1/project-store';
import { EndpointLocation } from '../budgets/budget-dock';
import { OpticalResult } from '../budgets/local-optical-panel';
import { ChannelField } from '../properties/channel-field';
import { LinkBudgetPanel } from './link-budget-panel';
import { LinkSupplyFields } from './link-supply-fields';
import { conversionKey, requiredEdgeKey } from './link-options';
import type { LinkOptions, Option } from './link-options';
import './link-editor.css';

type Props = {
  store: ProjectStore;
  project: Project;
  options: LinkOptions;
  selected?: NamedLink;
  result?: PathResult;
  budget: ReturnType<typeof createLinkBudget>;
  conditions: LinkTrial;
  setConditions: (conditions: LinkTrial) => void;
  draft?: boolean;
  opticalResult?: OpticalBudget;
  saveTrial: () => void;
  trialSaved: boolean;
  choose: (id?: string) => void;
  setDraftChannel: (channel: NamedLink['channelId']) => void;
  locate: (endpoint: EndpointRef) => void;
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
  resolved: '路径已解析', incomplete: '尚未连接', invalid_reference: '引用无效', unreachable: '尚未连接',
  ambiguous: '多条路径', feedback_loop: '存在反馈环', search_limit: '达到搜索上限',
};
const supplyLabels = { resolved: '供光路径已解析', missing: '缺少供光条件', ambiguous: '多条供光路径', feedback_loop: '供光反馈环', search_limit: '供光搜索达到上限' };

function Diagnostics({ result, showEndpoint, locate }: {
  result: PathResult; showEndpoint: LinkOptions['showEndpoint']; locate: (endpoint: EndpointRef) => void;
}) {
  return <div className="v1-link-diagnostics" role="status" data-path-status={result.status}>
    <strong>{statusLabels[result.status]}</strong>
    {result.status !== 'resolved' && <p>
      {result.status === 'incomplete' ? (result.endpoint ? '对外端口尚未连接到内部' : '缺少起点或终点') : result.reason}
      {result.endpoint && ` · ${showEndpoint(result.endpoint)}`}
    </p>}
    {result.trace && <details>
      <summary>主路径 · {result.trace.edges.length} 条边</summary>
      <ol>{result.trace.steps.map((step, index) => <li key={index}>
        <EndpointLocation endpoint={step.port.ref} label={showEndpoint(step.port.ref)} locate={locate} />{step.channelIds?.length ? ` · ${step.channelIds.join(' / ')}` : ''}
      </li>)}</ol>
    </details>}
    {!!result.trace?.supplies.length && <ul>{result.trace.supplies.map(supply =>
      <li key={supply.edgeIndex}>{supplyLabels[supply.status]} · {showEndpoint(supply.endpoint)}</li>)}</ul>}
  </div>;
}

export function LinkEditor({ store, project, options, selected, result, budget, conditions, setConditions,
  draft, opticalResult, saveTrial, trialSaved, choose, locate, setDraftChannel }: Props) {
  const [error, setError] = useState('');
  const [bindingId, setBindingId] = useState('');
  const binding = selected?.conversionBindings?.find(item => item.id === bindingId);
  const bindings = selected?.conversionBindings ?? [];
  const profiles = project.conversionProfiles ?? [];
  const [fromKey, setFromKey] = useState(selected?.from ? signalPortKey(selected.from) : '');
  const [toKey, setToKey] = useState(selected?.to ? signalPortKey(selected.to) : '');
  const domain = (key: string) => options.graph.ports.get(key)?.definition.type;
  const fromDomain = selected?.from && domain(signalPortKey(selected.from));
  const toDomain = selected?.to && domain(signalPortKey(selected.to));
  const opticalLink = fromDomain === 'OPTICAL' && toDomain === 'OPTICAL';
  const conversions = result?.trace?.conversions ?? [];
  const hasEo = conversions.some(step => step.kind === 'eo');
  const fullConversion = hasEo && conversions.some(step => step.kind === 'oe')
    && fromDomain === 'RF' && toDomain === 'RF';
  const showOptical = domain(fromKey) === 'OPTICAL' || domain(toKey) === 'OPTICAL' || conversions.length > 0 || bindings.length > 0;

  function commitLink(link: NamedLink) {
    const edit = store.commit(draft => ({
      ...draft,
      namedLinks: draft.namedLinks?.some(item => item.id === link.id)
        ? draft.namedLinks.map(item => item.id === link.id ? link : item)
        : [...(draft.namedLinks ?? []), link],
    }));
    setError(edit.ok ? '' : edit.message);
    if (edit.ok) choose(link.id);
    return edit.ok;
  }

  return <section className="panel v1-links" aria-labelledby="v1-links-title">
    <div className="v1-links-header">
      <h2 id="v1-links-title">链路</h2>
      <label htmlFor="link-selection">当前链路</label>
      <select id="link-selection" value={draft ? '' : selected?.id ?? ''} onChange={event => {
        choose(event.target.value || undefined);
        setError('');
      }}>
        <option value="">{draft ? '画布临时链路' : '新建链路'}</option>
        {project.namedLinks?.map(item => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}
      </select>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {result && <Diagnostics result={result} showEndpoint={options.showEndpoint} locate={locate} />}
    <details open={!selected || draft || undefined}>
      <summary>链路设置</summary>
      <form key={JSON.stringify(draft ? [selected?.from, selected?.to] : selected ?? null)} onSubmit={event => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const name = String(fields.get('name') ?? '').trim();
        if (!name) { setError('链路名称不能为空。'); return; }
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
      }} onChange={event => {
        const field = event.target;
        if (!(field instanceof HTMLSelectElement)) return;
        if (field.name === 'from') setFromKey(field.value);
        if (field.name === 'to') setToKey(field.value);
        if (draft && field.name === 'channel') setDraftChannel(resolveOpticalChannel(field.value)?.id);
      }}>
        <label>链路名称<input name="name" required defaultValue={selected?.name} /></label>
        <div className="v1-link-fields">
          <Choice title="起点" name="from" options={options.endpoints} value={selected?.from && signalPortKey(selected.from)} />
          <Choice title="终点" name="to" options={options.endpoints} value={selected?.to && signalPortKey(selected.to)} />
          {showOptical && <ChannelField label="光通道" name="channel" value={selected?.channelId}
            required={domain(fromKey) === 'OPTICAL' && domain(toKey) === 'OPTICAL'} />}
          {options.via.length > 0 && <details>
            <summary>必经连接{options.via.some(item => 'bundleId' in item.value) && '与 MPO 纤芯'}</summary>
            <label>约束路径（可多选）<select name="via" multiple size={4} defaultValue={selected?.via?.map(requiredEdgeKey) ?? []}>
              {options.via.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select></label>
          </details>}
        </div>
        <button type="submit">{selected && !draft ? '保存链路' : '保存为链路'}</button>
      </form>
    </details>
    {selected && <>
      {(hasEo || opticalLink || !!conditions.opticalSources?.length) && <LinkSupplyFields
        options={opticalLink && selected.from ? options.opticalSources.filter(item => item.key === signalPortKey(selected.from!)) : options.opticalSources}
        sources={conditions.opticalSources ?? []}
        onChange={opticalSources => setConditions({ ...conditions, opticalSources })} />}
      {opticalLink ? (opticalResult && selected.to
        ? <OpticalResult result={opticalResult} target={selected.to} showEndpoint={options.showEndpoint} locate={locate} />
        : <p role="status">{selected.via?.length ? '带必经边约束的光路可查看路径。请从光输出端口打开局部光功率，按供光条件试算。'
          : '光功率试算需要选定光通道和起点的供光条件。可在「供光查询」中填写光源功率。'}</p>)
        : <LinkBudgetPanel link={selected} budget={budget} conditions={conditions} labels={options} locate={locate}
          frequency={conditions.frequencyGHz} setFrequency={frequencyGHz => setConditions({ ...conditions, frequencyGHz })}
          setInputPower={inputPowerDbm => setConditions({ ...conditions, inputPowerDbm })} />}
      <div className="v1-trial-controls">
        <span role="status">{trialSaved ? '已保存到工程的试算条件' : '临时试算条件，仅在本次会话使用'}</span>
        <button type="button" onClick={saveTrial} disabled={draft || trialSaved
          || !Number.isFinite(conditions.frequencyGHz) || conditions.frequencyGHz < 0 || conditions.frequencyGHz > 67}>保存试算条件</button>
        {draft && <span>先保存链路，再保存试算条件。</span>}
      </div>
      {(fullConversion || bindings.length > 0) && <details>
        <summary>电光—光电标定绑定</summary>
        <label>工程内绑定<select value={binding?.id ?? ''} onChange={event => { setBindingId(event.target.value); setError(''); }}>
          <option value="">新建绑定</option>
          {bindings.map(item => <option key={item.id} value={item.id}>
            {profiles.find(profile => profile.id === item.profileId)?.name} · {options.showEndpoint({ instancePath: item.eo.instancePath, portId: item.eo.fromPortId })}
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
          if (!profile || !eo || !oe) { setError('请选择标定方案，并分别指定电光和光电转换边界。'); return; }
          const next: ConversionBinding = { ...binding, id: binding?.id ?? crypto.randomUUID(), profileId: profile.id, eo, oe };
          const conversionBindings = binding ? bindings.map(item => item.id === binding.id ? next : item) : [...bindings, next];
          if (commitLink({ ...selected, conversionBindings })) setBindingId(next.id);
        }}>
          <div className="v1-link-fields">
            <Choice title="标定方案" name="profile" required
              options={profiles.map(item => ({ key: item.id, label: item.name, value: item }))}
              value={binding?.profileId} />
            <Choice title="电光转换边界" name="eo" options={options.eo} required value={binding && conversionKey(binding.eo)} />
            <Choice title="光电转换边界" name="oe" options={options.oe} required value={binding && conversionKey(binding.oe)} />
          </div>
          {!profiles.length && <p>请先新建工程标定方案。</p>}
          <button type="submit" disabled={draft || !profiles.length || !options.eo.length || !options.oe.length}>{binding ? '保存绑定' : '创建绑定'}</button>
          {binding && <button type="button" onClick={() => {
            if (commitLink({ ...selected, conversionBindings: bindings.filter(item => item.id !== binding.id) })) setBindingId('');
          }}>移除绑定</button>}
        </form>
      </details>}
    </>}
  </section>;
}
