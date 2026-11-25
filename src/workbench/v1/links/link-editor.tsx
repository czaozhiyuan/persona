import { useMemo, useState } from 'react';
import type { createLinkBudget, LinkBudgetPoint } from '../../../engine/v1/link-budget';
import type { OpticalBudget } from '../../../engine/v1/optical-budget';
import type { PathResult } from '../../../engine/v1/path-resolver';
import { signalPortKey } from '../../../engine/v1/signal-graph';
import { resolveOpticalChannel } from '../../../model/v1/channels';
import type { LinkTrial, NamedLink } from '../../../model/v1/topology';
import type { EndpointRef } from '../../../model/v1/types';
import type { ProjectStore } from '../../../state/v1/project-store';
import { EndpointLocation } from '../budgets/budget-location';
import { OpticalResult } from '../budgets/local-optical-panel';
import { ChannelField } from '../properties/channel-field';
import { LinkBudgetPanel } from './link-budget-panel';
import { LinkSupplyFields } from './link-supply-fields';
import { requiredEdgeKey } from './link-options';
import type { LinkOptions, Option } from './link-options';
import './link-editor.css';

type Props = {
  store: ProjectStore;
  options: LinkOptions;
  point?: LinkBudgetPoint;
  opticalLink: boolean;
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

export function LinkEditor({ store, options, selected, result, budget, point, conditions, setConditions,
  draft, opticalLink, opticalResult, saveTrial, trialSaved, choose, locate, setDraftChannel }: Props) {
  const [error, setError] = useState('');
  const [fromKey, setFromKey] = useState(selected?.from ? signalPortKey(selected.from) : '');
  const [toKey, setToKey] = useState(selected?.to ? signalPortKey(selected.to) : '');
  const domain = (key: string) => options.graph.ports.get(key)?.definition.type;
  const fromDomain = selected?.from && domain(signalPortKey(selected.from));
  const conversions = result?.trace?.conversions ?? [];
  const hasEo = conversions.some(step => step.kind === 'eo');
  const crossesOptical = useMemo(() => {
    const control = domain(fromKey) === 'CONTROL' || domain(toKey) === 'CONTROL';
    if (!control && (domain(fromKey) !== 'RF' || domain(toKey) !== 'RF')) return false;
    if (fromKey === (selected?.from && signalPortKey(selected.from)) && toKey === (selected?.to && signalPortKey(selected.to))) {
      return !!result?.trace?.edges.some(edge => edge.channels.kind === 'enter' || edge.channels.kind === 'exit') || conversions.length > 0 || (result?.status === 'ambiguous' && options.eo.length > 0);
    }
    const path = budget.resolveNamedLink({ id: 'preview', name: '预览', from: options.graph.ports.get(fromKey)?.ref,
      to: options.graph.ports.get(toKey)?.ref });
    return !!path.trace?.edges.some(edge => edge.channels.kind === 'enter' || edge.channels.kind === 'exit') || (path.status === 'ambiguous' && options.eo.length > 0);
  }, [budget, options, selected, fromKey, toKey, result]);
  const showOptical = selected?.channelId || crossesOptical || domain(fromKey) === 'OPTICAL' || domain(toKey) === 'OPTICAL' || conversions.length > 0;

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

  const trialControls = <div className="v1-trial-controls">
    <span role="status">{trialSaved ? '已保存到工程的试算条件' : '临时试算条件，仅在本次会话使用'}</span>
    <button type="button" onClick={saveTrial} disabled={draft || trialSaved
      || !Number.isFinite(conditions.frequencyGHz) || conditions.frequencyGHz < 0 || conditions.frequencyGHz > 67}>保存试算条件</button>
    {draft && <span>先保存链路，再保存试算条件。</span>}
  </div>;
  const diagnostics = result && <Diagnostics result={result} showEndpoint={options.showEndpoint} locate={locate} />;
  return <section className="panel v1-links" aria-labelledby="v1-links-title">
    <div className="v1-links-header">
      <h2 id="v1-links-title">链路</h2>
      <label htmlFor="link-selection">当前链路</label>
      <select id="link-selection" value={draft ? '' : selected?.id ?? ''} onChange={event => {
        choose(event.target.value || undefined);
        setError('');
      }}>
        <option value="">{draft ? '画布临时链路' : '新建链路'}</option>
        {options.namedLinks.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
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
          {showOptical && <ChannelField label="光通道" name="channel" value={selected?.channelId} />}
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
      {(hasEo || fromDomain === 'OPTICAL' || !!conditions.opticalSources?.length) && <LinkSupplyFields
        options={opticalLink && selected.from ? options.opticalSources.filter(item => item.key === signalPortKey(selected.from!)) : options.opticalSources}
        sources={conditions.opticalSources ?? []}
        onChange={opticalSources => setConditions({ ...conditions, opticalSources })} />}

      {opticalLink ? <>{trialControls}{opticalResult && selected.to
        ? <OpticalResult result={opticalResult} target={opticalResult.stages.at(-1)?.endpoint ?? selected.to} showEndpoint={options.showEndpoint} locate={locate} />
        : <p role="status">请检查光路。</p>}{diagnostics}</>
        : point && <LinkBudgetPanel trialControls={trialControls} diagnostics={diagnostics} single={point} link={selected} budget={budget} conditions={conditions} labels={options} locate={locate}
          frequency={conditions.frequencyGHz} setFrequency={frequencyGHz => setConditions({ ...conditions, frequencyGHz })}
          setInputPower={inputPowerDbm => setConditions({ ...conditions, inputPowerDbm })} />}
    </>}
  </section>;
}
