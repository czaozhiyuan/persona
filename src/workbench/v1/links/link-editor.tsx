import { useMemo, useState } from 'react';
import type { createLinkBudget, LinkBudgetPoint } from '../../../engine/v1/link-budget';
import type { OpticalBudget } from '../../../engine/v1/optical-budget';
import type { PathResult } from '../../../engine/v1/path-resolver';
import { isDigitalEdge, signalPortKey } from '../../../engine/v1/signal-graph';
import { resolveOpticalChannel } from '../../../model/v1/channels';
import type { LinkTrial, NamedLink } from '../../../model/v1/topology';
import { isPowerPort } from '../../../model/v1/types';
import type { EndpointRef } from '../../../model/v1/types';
import type { ProjectStore } from '../../../state/v1/project-store';
import { EndpointLocation } from '../budgets/budget-location';
import { OpticalResult } from '../budgets/local-optical-panel';
import { ChannelField } from '../properties/channel-field';
import { LinkBudgetPanel } from './link-budget-panel';
import { LinkSupplyFields } from './link-supply-fields';
import type { LinkFields } from './link-draft';
import { requiredEdgeKey } from './link-options';
import type { LinkOptions, Option } from './link-options';
import './link-editor.css';

type Props = {
  store: ProjectStore;
  options: LinkOptions;
  point?: LinkBudgetPoint;
  opticalLink: boolean;
  signalNotice?: string;
  selected?: NamedLink;
  result?: PathResult;
  budget: ReturnType<typeof createLinkBudget>;
  conditions: LinkTrial;
  setConditions: (conditions: LinkTrial) => void;
  draft?: 'edit' | 'new';
  formLink?: NamedLink;
  opticalResult?: OpticalBudget;
  saveTrial: () => void;
  trialSaved: boolean;
  choose: (id?: string) => void;
  changeFields: (fields: LinkFields) => void;
  locate: (endpoint: EndpointRef) => void;
};

function EndpointChoice({ name, title, options, current, retainedLabel, power, onChange }: {
  name: string; title: string; options: Option<EndpointRef>[]; current?: Option<EndpointRef>;
  retainedLabel: string; power: boolean; onChange: (key: string) => void;
}) {
  const retained = current && !options.some(item => item.key === current.key);
  return <label>{title}<select name={name} value={current?.key ?? ''} onChange={event => onChange(event.target.value)}>
    <option value="">未设置</option>
    {options.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
    {retained && <option value={current.key} disabled={power}>{current.label}（当前端点 · {retainedLabel}）</option>}
  </select></label>;
}

const statusLabels = {
  resolved: '已找到路径', incomplete: '尚未连接', invalid_reference: '引用无效', unreachable: '尚未连接',
  ambiguous: '多条路径', feedback_loop: '存在反馈环', search_limit: '达到搜索上限',
};
const supplyLabels = { resolved: '供光路径已解析', missing: '缺少供光条件', ambiguous: '多条供光路径', feedback_loop: '供光反馈环', search_limit: '供光搜索达到上限' };

function Diagnostics({ result, showEndpoint, locate }: {
  result: PathResult; showEndpoint: LinkOptions['showEndpoint']; locate: (endpoint: EndpointRef) => void;
}) {
  const parallelDark = result.trace?.edges.some(edge => edge.source.kind === 'darkParallelPaths');
  const boundaries = result.status !== 'resolved' && result.digitalAccess?.filter(isDigitalEdge);
  return <div className="v1-link-diagnostics" role="status" data-path-status={result.status}>
    <strong>{statusLabels[result.status]}</strong>
    {parallelDark && <p>分路后重汇的光路均无光。</p>}
    {result.status !== 'resolved' && <p>
      {result.status === 'incomplete' ? (result.endpoint ? '对外端口尚未连接到内部' : '缺少起点或终点') : result.reason}
      {result.endpoint && ` · ${showEndpoint(result.endpoint)}`}
    </p>}
    {boundaries && boundaries.length > 0 && <p>已连接的数字光边界：{boundaries.map(edge => {
      const ref = (edge.from.definition.type === 'OPTICAL' ? edge.from : edge.to).ref;
      return <EndpointLocation key={signalPortKey(ref)} endpoint={ref} label={showEndpoint(ref)} locate={locate} />;
    })}</p>}
    {result.trace && <details>
      <summary>{parallelDark ? '各支路共有的端口' : '查看路径'}</summary>
      <ol>{result.trace.steps.map((step, index) => <li key={index}>
        <EndpointLocation endpoint={step.port.ref} label={showEndpoint(step.port.ref)} locate={locate} />{step.channelIds?.length ? ` · ${step.channelIds.join(' / ')}` : ''}
      </li>)}</ol>
    </details>}
    {!!result.trace?.supplies.length && <ul>{result.trace.supplies.map(supply =>
      <li key={supply.edgeIndex}>{supplyLabels[supply.status]} · {showEndpoint(supply.endpoint)}</li>)}</ul>}
  </div>;
}

export function LinkEditor({ store, options, selected, result, budget, point, conditions, setConditions,
  draft, formLink, opticalLink, signalNotice, opticalResult, saveTrial, trialSaved, choose, locate, changeFields }: Props) {
  const [error, setError] = useState('');
  const fromKey = formLink?.from ? signalPortKey(formLink.from) : '';
  const toKey = formLink?.to ? signalPortKey(formLink.to) : '';
  const [local, setLocal] = useState(false);
  const channel = formLink?.channelId;
  const choices = useMemo(() => options.endpointChoices(fromKey, channel, local), [options, fromKey, channel, local]);
  const currentFrom = options.endpoints.find(item => item.key === fromKey);
  const currentTo = options.endpoints.find(item => item.key === toKey);
  const domain = (key: string) => options.graph.ports.get(key)?.definition.type;
  const fromDomain = selected?.from && domain(signalPortKey(selected.from));
  const conversions = result?.trace?.conversions ?? [];
  const hasEo = conversions.some(step => step.kind === 'eo');
  const crossesOptical = useMemo(() => {
    const control = domain(fromKey) === 'CONTROL' || domain(toKey) === 'CONTROL';
    if (!control && (domain(fromKey) !== 'RF' || domain(toKey) !== 'RF')) return false;
    const savedEnds = fromKey === (selected?.from && signalPortKey(selected.from)) && toKey === (selected?.to && signalPortKey(selected.to));
    const path = savedEnds ? result : budget.resolveNamedLink({ id: 'preview', name: '预览',
      from: options.graph.ports.get(fromKey)?.ref, to: options.graph.ports.get(toKey)?.ref });
    return !!(path && path.status !== 'resolved' && path.digitalAccess)
      || !!path?.trace?.edges.some(edge => edge.channels.kind === 'enter' || edge.channels.kind === 'exit')
      || (path?.status === 'ambiguous' && options.eo.length > 0);
  }, [budget, options, selected, fromKey, toKey, result]);
  const showOptical = channel || crossesOptical || domain(fromKey) === 'OPTICAL' || domain(toKey) === 'OPTICAL' || conversions.length > 0;

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
    <span role="status">{trialSaved ? '已存入工程' : '仅本次试算'}</span>
    <button type="button" onClick={saveTrial} disabled={!!draft || trialSaved
      || !Number.isFinite(conditions.frequencyGHz) || conditions.frequencyGHz < 0 || conditions.frequencyGHz > 67}>保存试算条件</button>
    {draft && <span>先保存链路，再保存试算条件。</span>}
  </div>;
  const diagnostics = result && <Diagnostics result={result} showEndpoint={options.showEndpoint} locate={locate} />;
  return <section className="panel v1-links" aria-labelledby="v1-links-title">
    <div className="v1-links-header">
      <h2 id="v1-links-title">链路</h2>
      <label htmlFor="link-selection">当前链路</label>
      <select id="link-selection" value={draft === 'new' ? '' : selected?.id ?? ''} onChange={event => {
        choose(event.target.value || undefined);
        setError('');
      }}>
        <option value="">{draft === 'new' ? '画布临时链路' : '新建链路'}</option>
        {options.namedLinks.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
    </div>
    {draft === 'edit' && <p role="status">正在修改「{selected?.name}」的端点，保存后生效。</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <details open={!selected || !!draft || undefined}>
      <summary>链路设置</summary>
      <form onSubmit={event => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const name = String(fields.get('name') ?? '').trim();
        if (!name) { setError('链路名称不能为空。'); return; }
        const via = fields.getAll('via').map(key => options.via.find(item => item.key === key)?.value);
        const rawChannel = String(fields.get('channel') ?? '');
        const channel = rawChannel ? resolveOpticalChannel(rawChannel) : undefined;
        if (via.some(item => !item) || (rawChannel && !channel)) {
          setError('端口、必经边或通道已失效，请重新选择。');
          return;
        }
        const required = via.filter(item => item !== undefined);
        commitLink({ ...selected, id: selected?.id ?? crypto.randomUUID(), name, from: currentFrom?.value, to: currentTo?.value,
          channelId: channel?.id, via: required.length ? required : undefined });
      }} onChange={event => {
        const field = event.target;
        if (field instanceof HTMLSelectElement && field.name === 'channel') {
          const next = resolveOpticalChannel(field.value)?.id;
          changeFields({ channelId: next ?? '' });
        }
      }}>
        <label>链路名称<input key={draft === 'new' ? undefined : selected?.name} name="name" required defaultValue={selected?.name} /></label>
        <div className="v1-link-fields">
          <EndpointChoice title="起点" name="from" options={choices.from} current={currentFrom} retainedLabel="局部"
            power={isPowerPort(domain(fromKey))} onChange={from => changeFields({ from })} />
          <EndpointChoice title="终点" name="to" options={choices.to} current={currentTo}
            retainedLabel={choices.systemEnds.has(toKey) ? '尚未接通' : '局部'} power={isPowerPort(domain(toKey))} onChange={to => changeFields({ to })} />
          <label className="v1-local-endpoints"><input type="checkbox" checked={local}
            onChange={event => setLocal(event.target.checked)} />显示局部及未接通端点</label>
          {choices.limited && <p role="status">可达性搜索达到上限，已保留系统级终点。</p>}
          {!local && (!choices.from.length || !choices.to.length) && <p role="status">请检查接线，或开启「显示局部及未接通端点」。</p>}
          {showOptical && <ChannelField key={draft ? undefined : selected?.channelId} label="光通道" name="channel" value={channel} />}
          {options.via.length > 0 && <details>
            <summary>必经连接{options.via.some(item => 'bundleId' in item.value) && '与 MPO 纤芯'}</summary>
            <label>约束路径（可多选）<select key={JSON.stringify(selected?.via)} name="via" multiple size={4} defaultValue={selected?.via?.map(requiredEdgeKey) ?? []}>
              {options.via.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select></label>
          </details>}
        </div>
        <button type="submit">{draft === 'edit' ? '保存当前链路修改' : selected && !draft ? '保存链路' : '保存为链路'}</button>
        {draft && <button type="button" onClick={() => choose(draft === 'edit' ? selected?.id : undefined)}>取消{draft === 'edit' ? '修改' : '新建'}</button>}
      </form>
    </details>
    {selected && <>
      {(!signalNotice || opticalLink) && (hasEo || fromDomain === 'OPTICAL' || !!conditions.opticalSources?.length) && <LinkSupplyFields
        options={opticalLink && selected.from ? options.opticalSources.filter(item => item.key === signalPortKey(selected.from!)) : options.opticalSources}
        sources={conditions.opticalSources ?? []}
        onChange={opticalSources => setConditions({ ...conditions, opticalSources })} />}

      {signalNotice ? <><p role="status">{signalNotice}</p>{diagnostics}</> : opticalLink ? <>{trialControls}{opticalResult && selected.to
        ? <OpticalResult result={opticalResult} target={opticalResult.stages.at(-1)?.endpoint ?? selected.to} showEndpoint={options.showEndpoint} locate={locate} />
        : <p role="status">请检查光路。</p>}{diagnostics}</>
        : point && <LinkBudgetPanel trialControls={trialControls} diagnostics={diagnostics} single={point} link={selected} budget={budget} conditions={conditions} labels={options} locate={locate}
          frequency={conditions.frequencyGHz} setFrequency={frequencyGHz => setConditions({ ...conditions, frequencyGHz })}
          setInputPower={inputPowerDbm => setConditions({ ...conditions, inputPowerDbm })} />}
    </>}
  </section>;
}
