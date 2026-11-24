import { useState } from 'react';
import type { LocalOpticalRequest, OpticalBudget, OpticalSource } from '../../../engine/v1/optical-budget';
import { signalPortKey } from '../../../engine/v1/signal-graph';
import { resolveOpticalChannel } from '../../../model/v1/channels';
import { conversionKey } from '../links/link-options';
import type { LinkOptions, Option } from '../links/link-options';
import { LinkSupplyFields } from '../links/link-supply-fields';
import { ChannelField } from '../properties/channel-field';
import type { EndpointRef } from '../../../model/v1/types';
import { EndpointLocation } from './budget-location';
import { Metric, Rating } from './budget-values';

type OpticalQuery = Extract<LocalOpticalRequest, { source: OpticalSource }>
  | Omit<Extract<LocalOpticalRequest, { sources: readonly OpticalSource[] }>, 'sources'>;

export type LocalOpticalSettings = { query?: OpticalQuery; sources: readonly OpticalSource[] };

const statusLabels = { valid: '可计算', partial: '部分可计算', error: '不可计算' };

function PortSelect({ name, label, options, value }: {
  name: string; label: string; options: readonly Option<unknown>[]; value?: string;
}) {
  return <label>{label}<select name={name} defaultValue={value ?? ''} required>
    <option value="">请选择</option>
    {options.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
  </select></label>;
}

export function LocalOpticalPanel({ options, settings, onChange, target, result, locate }: {
  options: LinkOptions; settings: LocalOpticalSettings; onChange: (settings: LocalOpticalSettings) => void;
  target?: EndpointRef; result?: OpticalBudget; locate: (endpoint: EndpointRef) => void;
}) {
  const { query, sources } = settings;
  const targetKey = target && signalPortKey(target);
  const [mode, setMode] = useState<'direct' | 'eo'>(query && 'eo' in query ? 'eo' : 'direct');
  const direct = query && 'source' in query ? query.source : undefined;
  const eo = query && 'eo' in query ? query : undefined;
  const chosenSource = options.opticalSources.find(item => item.key === targetKey);
  const targetPort = targetKey ? options.graph.ports.get(targetKey)?.definition : undefined;

  return <section className="panel v1-budget-report" aria-labelledby="v1-optical-heading">
    <h2 id="v1-optical-heading">局部光功率</h2>
    <p>默认按器件有效光功率计算，临时功率可覆盖器件值。</p>
    <label>计算方式<select name="opticalMode" value={mode} onChange={event => setMode(event.currentTarget.value === 'eo' ? 'eo' : 'direct')}>
      <option value="direct">纯光路径</option>
      <option value="eo">外部供光的电光路径</option>
    </select></label>
    {!query && target && <p role="status">目标为 {options.showEndpoint(target)}。请选择供光来源和光通道，并填写已知的光源功率。</p>}
    {!options.opticalEndpoints.length && <p className="empty">当前工程没有可查询的光端口。</p>}
    {mode === 'eo' && <LinkSupplyFields options={options.opticalSources} sources={sources}
      onChange={next => onChange({ ...settings, sources: next })} />}
    <form key={mode} onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const to = options.opticalEndpoints.find(item => item.key === data.get('opticalTarget'))?.value;
      const channel = resolveOpticalChannel(String(data.get('opticalChannel') ?? ''));
      if (!to || !channel) return;
      if (mode === 'eo') {
        const boundary = options.eo.find(item => item.key === data.get('opticalEo'))?.value;
        if (boundary) onChange({ ...settings, query: { to, eo: boundary, channelId: channel.id } });
      } else {
        const endpoint = options.opticalSources.find(item => item.key === data.get('opticalSource'))?.value;
        const power = data.get('opticalPower');
        if (endpoint) onChange({ ...settings, query: { to, source: {
          endpoint, channelId: channel.id, powerDbm: typeof power === 'string' && power !== '' ? Number(power) : undefined,
        } } });
      }
    }}>
      <div className="v1-link-fields">
        {mode === 'direct' ? <PortSelect name="opticalSource" label="光源端口" options={options.opticalSources}
          value={direct ? signalPortKey(direct.endpoint) : chosenSource?.key} /> : <PortSelect name="opticalEo" label="电光转换边界" options={options.eo}
          value={eo && conversionKey(eo.eo)} />}
        <PortSelect name="opticalTarget" label="目标光端口" options={options.opticalEndpoints} value={query ? signalPortKey(query.to) : targetKey} />
        <ChannelField name="opticalChannel" label={mode === 'eo' ? '电光转换输出通道' : '光源通道'}
          value={mode === 'eo' ? eo?.channelId : direct?.channelId ?? targetPort?.channelIds?.[0]} required />
        {mode === 'direct' && <label>光源功率 (dBm，可选)
          <input name="opticalPower" type="number" step="any" placeholder="未知" defaultValue={direct?.powerDbm} />
        </label>}
      </div>
      <button type="submit" disabled={!options.opticalEndpoints.length || (mode === 'eo' ? !options.eo.length : !options.opticalSources.length)}>
        计算局部光功率
      </button>
    </form>
    {result && query && (('eo' in query) === (mode === 'eo')) &&
      <OpticalResult result={result} target={query.to} showEndpoint={options.showEndpoint} locate={locate} />}
  </section>;
}

export function OpticalResult({ result, target, showEndpoint, locate }: {
  result: OpticalBudget; target: EndpointRef; showEndpoint: LinkOptions['showEndpoint']; locate?: (endpoint: EndpointRef) => void;
}) {
  const lossColumns = result.stages.some(stage => stage.incoming?.opticalLoss !== undefined);
  return <div className="v1-local-optical-result" data-budget-status={result.status}>
      <h3>{showEndpoint(target)} · {statusLabels[result.status]}</h3>
      <dl className="v1-budget-metrics">
        <div><dt>目标光功率</dt><dd data-metric="optical-power"><Metric metric={result.powerDbm} /></dd></div>
        {result.digitalReceiver && <>
          <div><dt>接收灵敏度</dt><dd><Metric metric={result.digitalReceiver.sensitivity} /></dd></div>
          <div><dt>接收余量</dt><dd><Metric metric={result.digitalReceiver.margin} />{result.digitalReceiver.margin.availability === 'available'
            && (result.digitalReceiver.margin.value < 0 ? ' · 低于灵敏度' : ' · 达到灵敏度')}</dd></div>
          <div><dt>接收过载上限</dt><dd><Metric metric={result.digitalReceiver.overload} />{result.digitalReceiver.aboveLimit !== undefined
            && (result.digitalReceiver.aboveLimit ? ' · 超过上限' : ' · 未超过上限')}</dd></div>
        </>}
        {result.averageCurrent && <div><dt>平均光电流</dt><dd><Metric metric={result.averageCurrent} /></dd></div>}
        <div><dt>累计光增益</dt><dd data-metric="optical-gain"><Metric metric={result.gainDb} /></dd></div>
      </dl>
      {result.pathIssue && <p role="status" data-path-status={result.pathIssue.status}>
        {result.pathIssue.reason} · {showEndpoint(result.pathIssue.endpoint)}
      </p>}
      {result.stages.length > 0 && <div className="v1-budget-table"><table><thead><tr>
        <th>光端口</th><th>通道</th><th>光功率</th><th>本级增益</th>
        {lossColumns && <><th>最大透过插损</th><th>正交损耗</th></>}
        <th>输入额定</th>
      </tr></thead><tbody>{result.stages.map((stage, index) => <tr key={index}>
        <th scope="row"><EndpointLocation endpoint={stage.endpoint} label={showEndpoint(stage.endpoint)} locate={locate} /></th><td>{stage.channelId}</td>
        <td><Metric metric={stage.powerDbm} /></td><td><Metric metric={stage.incoming?.gainDb} /></td>
        {lossColumns && <><td><Metric metric={stage.incoming?.opticalLoss?.intrinsicLossDb} /></td>
          <td><Metric metric={stage.incoming?.opticalLoss?.quadratureLossDb} /></td></>}
        <td><Rating check={stage.rating} /></td>
      </tr>)}</tbody></table></div>}
    </div>;
}
