import { useMemo, useState } from 'react';
import type { createLinkBudget, LinkBudgetConditions, LinkBudgetPoint, RfScanRange } from '../../../engine/v1/link-budget';
import type { EndpointRef } from '../../../model/v1/types';
import { EndpointLocation } from '../budgets/budget-dock';
import type { NamedLink } from '../../../model/v1/topology';
import { RfScanPlot, scanMetrics } from './rf-scan-plot';
import type { ScanMetric } from './rf-scan-plot';
import type { LinkOptions } from './link-options';
import { Metric, Rating } from '../budgets/budget-values';

const statusLabels = { valid: '可计算', partial: '部分可计算', error: '不可计算' };

type PortLabels = Pick<LinkOptions, 'showEndpoint' | 'showPort'>;

function PointDetails({ point, labels: { showEndpoint, showPort }, locate }: {
  point: LinkBudgetPoint; labels: PortLabels; locate: (endpoint: EndpointRef) => void;
}) {
  const issue = point.kind !== 'conversion' ? point.pathIssue : undefined;
  return <div className="v1-point-details" data-budget-status={point.status}>
    <h4>{Number.isFinite(point.frequencyGHz) ? `${point.frequencyGHz} GHz` : '频率未设'} · {statusLabels[point.status]}</h4>
    <dl className="v1-budget-metrics">
      {(['gainDb', 'powerDbm', 'nfDb'] as const).map(key => <div key={key}>
        <dt>{scanMetrics[key]}</dt><dd data-metric={key}><Metric metric={point[key]} /></dd>
      </div>)}
    </dl>
    {issue && <p role="status">{issue.reason}{issue.endpoint && ` · ${showEndpoint(issue.endpoint)}`}</p>}
    {point.kind === 'rf' && point.stages.length > 0 && <details>
      <summary>纯射频逐级结果</summary>
      <div className="v1-budget-table"><table><thead><tr>
        <th>端口</th><th>射频功率</th><th>本级增益</th><th>累计增益</th><th>累计噪声系数</th><th>输入额定</th>
      </tr></thead><tbody>{point.stages.map(stage => <tr key={JSON.stringify(stage.endpoint)}>
        <th scope="row"><EndpointLocation endpoint={stage.endpoint} label={showEndpoint(stage.endpoint)} locate={locate} /></th>
        <td><Metric metric={stage.powerDbm} /></td><td><Metric metric={stage.incoming?.device?.gainDb} /></td>
        <td><Metric metric={stage.cumulativeGainDb} /></td><td><Metric metric={stage.cumulativeNfDb} /></td>
        <td><Rating check={stage.rating} /></td>
      </tr>)}</tbody></table></div>
    </details>}
    {point.kind === 'conversion' && <>
      {point.diagnostics.length > 0 && <ul className="v1-budget-reasons">{point.diagnostics.map((item, index) => <li key={index}>
        {item.code === 'missing_binding' || item.code === 'missing_gain' ? '缺少参数 · ' : ''}
        {item.reason}{item.endpoint && ` · ${showEndpoint(item.endpoint)}`}{item.bindingId && ` · ${item.bindingId}`}
      </li>)}</ul>}
      {point.segments.map(segment => <details key={segment.eoEdgeIndex}>
        <summary>电光—光电标定段 · {showEndpoint(segment.pdInput)}{segment.channelId && ` · ${segment.channelId}`}</summary>
        <dl className="v1-budget-metrics">
          <div><dt>探测器光功率</dt><dd data-metric="pd-power"><Metric metric={segment.pdPowerDbm} /></dd></div>
          <div><dt>标定段增益</dt><dd data-metric="conversion-gain"><Metric metric={segment.gainDb} /></dd></div>
          <div><dt>标定段输出射频功率</dt><dd><Metric metric={segment.rfOutputDbm} /></dd></div>
        </dl>
        {segment.optical?.stages.length ? <div className="v1-budget-table"><table><thead><tr>
          <th>光端口</th><th>通道</th><th>光功率</th><th>本级增益</th><th>输入额定</th>
        </tr></thead><tbody>{segment.optical.stages.map((stage, index) => <tr key={index}>
          <th scope="row"><EndpointLocation endpoint={stage.endpoint} label={showEndpoint(stage.endpoint)} locate={locate} /></th><td>{stage.channelId}</td>
          <td><Metric metric={stage.powerDbm} /></td><td><Metric metric={stage.incoming?.gainDb} /></td>
          <td><Rating check={stage.rating} /></td>
        </tr>)}</tbody></table></div> : null}
      </details>)}
      {point.rfStages.length > 0 && <details>
        <summary>标定段外的射频级</summary>
        <div className="v1-budget-table"><table><thead><tr>
          <th>端口</th><th>本级增益</th><th>本级噪声系数</th><th>输出功率</th><th>输入额定</th>
        </tr></thead><tbody>{point.rfStages.map(stage => <tr key={stage.edgeIndex}>
          <th scope="row"><EndpointLocation endpoint={stage.input} label={showEndpoint(stage.input)} locate={locate} /> → {showPort(stage.output)}</th>
          <td><Metric metric={stage.gainDb} /></td><td><Metric metric={stage.nfDb} /></td>
          <td><Metric metric={stage.powerDbm} /></td><td><Rating check={stage.rating} /></td>
        </tr>)}</tbody></table></div>
      </details>}
    </>}
  </div>;
}

export function LinkBudgetPanel({ link, budget, conditions, frequency, setFrequency, setInputPower, labels, locate }: {
  link: NamedLink;
  labels: PortLabels;
  budget: ReturnType<typeof createLinkBudget>;
  conditions: LinkBudgetConditions;
  frequency: number;
  setFrequency: (frequency: number) => void;
  setInputPower: (power: number | undefined) => void;
  locate: (endpoint: EndpointRef) => void;
}) {
  const [range, setRange] = useState<RfScanRange>();
  const [scanFrequency, setScanFrequency] = useState<number>();
  const [metric, setMetric] = useState<ScanMetric>('gainDb');
  const single = useMemo(() => budget.calculateNamedLink(link, { ...conditions, frequencyGHz: frequency }),
    [budget, conditions, frequency, link]);
  const scan = useMemo(() => range && budget.scanNamedLink(link, range, conditions), [budget, conditions, link, range]);
  const selectedPoint = scan?.status === 'complete' &&
    (scan.points.find(point => point.frequencyGHz === scanFrequency) ?? scan.points[0]);

  return <section className="v1-link-budget" aria-labelledby="v1-link-budget-heading">
    <h3 id="v1-link-budget-heading">链路预算</h3>
    <div className="v1-link-fields">
      <label>单点频率 (GHz)<input name="budgetFrequency" type="number" min={0} max={67} step="any"
        value={Number.isFinite(frequency) ? frequency : ''} onChange={event => setFrequency(event.currentTarget.valueAsNumber)} /></label>
      <label>射频输入功率 (dBm，可选)<input name="budgetInputPower" type="number" step="any"
        value={conditions.inputPowerDbm ?? ''} placeholder="未知" onChange={event => {
          const value = event.currentTarget.valueAsNumber;
          setInputPower(Number.isFinite(value) ? value : undefined);
        }} /></label>
    </div>
    <div className="v1-single-point"><PointDetails point={single} labels={labels} locate={locate} /></div>
    <details>
      <summary>射频扫描 · 1 GHz 步长</summary>
      <form onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const startGHz = Number(data.get('scanStart'));
        setRange({ startGHz, stopGHz: Number(data.get('scanStop')) });
        setScanFrequency(startGHz);
      }}>
        <div className="v1-link-fields">
          <label>起始频率 (GHz)<input name="scanStart" type="number" min={0} max={67} defaultValue={0} step={1} required /></label>
          <label>终止频率 (GHz)<input name="scanStop" type="number" min={0} max={67} defaultValue={67} step={1} required /></label>
        </div>
        <button type="submit">运行扫描</button>
      </form>
      {scan?.status === 'invalid_range' && <p className="error" role="alert">{scan.reason}</p>}
      {scan?.status === 'complete' && selectedPoint && <>
        <div className="v1-link-fields">
          <label>曲线指标<select value={metric} onChange={event => setMetric(event.target.value as ScanMetric)}>
            {Object.entries(scanMetrics).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
          <label>查看频点<select name="scanPoint" value={selectedPoint.frequencyGHz}
            onChange={event => setScanFrequency(Number(event.target.value))}>
            {scan.points.map(point => <option key={point.frequencyGHz} value={point.frequencyGHz}>
              {point.frequencyGHz} GHz · {statusLabels[point.status]}
            </option>)}
          </select></label>
        </div>
        <RfScanPlot points={scan.points} metric={metric} selected={selectedPoint.frequencyGHz} />
        <div className="v1-scan-point"><PointDetails point={selectedPoint} labels={labels} locate={locate} /></div>
      </>}
    </details>
  </section>;
}
