import { loadedVoltages } from '../../../engine/v1/conversion-budget';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import type { createLinkBudget, LinkBudgetConditions, LinkBudgetPoint, RfScanRange } from '../../../engine/v1/link-budget';
import type { EndpointRef } from '../../../model/v1/types';
import { EndpointLocation } from '../budgets/budget-location';
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
  const voltages = loadedVoltages(point.powerDbm);
  const dml = point.kind === 'conversion' && (point.partialDml || point.segments.some(s => s.transmitter.kind === 'dml'));
  return <div className="v1-point-details" data-budget-status={point.status}>
    <h4>{Number.isFinite(point.frequencyGHz) ? `${point.frequencyGHz} GHz` : '频率未设'} · {point.frequencyGHz === 0 && '低频极限参考 · '}{point.kind === 'conversion' && (dml ? '直调小信号幅度估算 · ' : '正交小信号幅度估算 · ')}{statusLabels[point.status]}</h4>
    <dl className="v1-budget-metrics">
      {(['gainDb', 'powerDbm', 'nfDb'] as const).map(key => <div key={key}>
        <dt>{key === 'gainDb' && point.kind === 'conversion' ? '小信号射频增益' : scanMetrics[key]}</dt><dd data-metric={key}><Metric metric={point[key]} /></dd>
      </div>)}
      {point.kind === 'conversion' && <>
        <div><dt>外部 50 Ω Vrms</dt><dd><Metric metric={voltages.vrms} /></dd></div>
        <div><dt>外部 50 Ω Vpp</dt><dd><Metric metric={voltages.vpp} /></dd></div>
      </>}
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
      {(point.segments.some(segment => segment.extrapolated) || point.partialDml?.extrapolated) &&
        <p className="v1-budget-warning">超出小信号范围，结果为线性外推</p>}
      {point.diagnostics.length > 0 && <ul className="v1-budget-reasons">{point.diagnostics.map((item, index) => <li key={index}>
        {item.code === 'missing_gain' ? '缺少参数 · ' : ''}
        {item.reason}{item.endpoint && ` · ${showEndpoint(item.endpoint)}`}
      </li>)}</ul>}
      {point.partialDml && <dl className="v1-budget-metrics">
        <div><dt>DML 平均输出光功率 P0</dt><dd><Metric metric={point.partialDml.emission.mean} /></dd></div>
        <div><dt>直调系数 K(f)</dt><dd><Metric metric={point.partialDml.emission.slope} /></dd></div>
        <div><dt>调制深度 m</dt><dd><Metric metric={point.partialDml.emission.modulationDepth} /></dd></div>
        {point.partialDml.optical?.stages.slice(1).map(stage => <div key={JSON.stringify(stage.endpoint)}>
          <dt>{showEndpoint(stage.endpoint)} · 光功率</dt><dd><Metric metric={stage.powerDbm} /></dd>
        </div>)}
      </dl>}
      {point.continuousWave && <dl className="v1-budget-metrics">
        <div><dt>探测器平均信号光功率</dt><dd><Metric metric={point.continuousWave.optical.powerDbm} /></dd></div>
        <div><dt>平均光电流</dt><dd><Metric metric={point.continuousWave.averageCurrent} /></dd></div>
      </dl>}
      {point.segments.map(segment => <details key={segment.eoEdgeIndex}>
        <summary>电光—光电转换段 · {showEndpoint(segment.pdInput)}{segment.channelId && ` · ${segment.channelId}`}</summary>
        <dl className="v1-budget-metrics">
          {segment.transmitter.kind === 'mzm'
            ? <div><dt>RF 半波电压 Vπ</dt><dd><Metric metric={segment.transmitter.vPi} /></dd></div>
            : <>
              <div><dt>DML 平均输出光功率 P0</dt><dd><Metric metric={segment.transmitter.mean} /></dd></div>
              <div><dt>直调系数 K(f)</dt><dd><Metric metric={segment.transmitter.slope} /></dd></div>
              <div><dt>DML 射频输入峰值电压</dt><dd><Metric metric={segment.transmitter.inputPeak} /></dd></div>
              <div><dt>DML 交流光功率峰值</dt><dd><Metric metric={segment.transmitter.opticalPeak} /></dd></div>
              <div><dt>PD 交流光功率峰值</dt><dd><Metric metric={segment.transmitter.receivedPeak} /></dd></div>
              <div><dt>PD 已加载转换系数</dt><dd><Metric metric={segment.transmitter.loadedResponse} /></dd></div>
              <div><dt>PD 射频输出峰值电压</dt><dd><Metric metric={loadedVoltages(segment.rfOutputDbm).vpk} /></dd></div>
            </>}
          <div><dt>响应度</dt><dd><Metric metric={segment.responsivity} /></dd></div>
          <div><dt>调制深度 m</dt><dd><Metric metric={segment.modulationDepth} />{segment.extrapolated && ' · 线性外推'}</dd></div>
          <div><dt>平均光电流</dt><dd><Metric metric={segment.averageCurrent} /></dd></div>
          <div><dt>{segment.transmitter.kind === 'dml' ? 'DML' : 'MZM'} 输入</dt><dd><Rating check={segment.inputRating} showStatus /></dd></div>
          <div><dt>探测器光功率</dt><dd data-metric="pd-power"><Metric metric={segment.pdPowerDbm} /></dd></div>
          <div><dt>转换段增益</dt><dd data-metric="conversion-gain"><Metric metric={segment.gainDb} /></dd></div>
          <div><dt>转换段输出射频功率</dt><dd><Metric metric={segment.rfOutputDbm} /></dd></div>
        </dl>
        {segment.optical?.stages.length ? <div className="v1-budget-table"><table><thead><tr>
          <th>光端口</th><th>通道</th><th>光功率</th><th>本级增益</th><th>输入额定</th>
        </tr></thead><tbody>{segment.optical.stages.map((stage, index) => <tr key={index}>
          <th scope="row"><EndpointLocation endpoint={stage.endpoint} label={showEndpoint(stage.endpoint)} locate={locate} /></th><td>{stage.channelId ?? '—'}</td>
          <td><Metric metric={stage.powerDbm} /></td><td><Metric metric={stage.incoming?.gainDb} /></td>
          <td><Rating check={stage.rating} /></td>
        </tr>)}</tbody></table></div> : null}
      </details>)}
      {point.rfStages.length > 0 && <details>
        <summary>转换段外的射频级</summary>
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

export function LinkBudgetPanel({ trialControls, diagnostics, link, budget, single, conditions, frequency, setFrequency, setInputPower, labels, locate }: {
  trialControls: ReactNode;
  diagnostics: ReactNode;
  single: LinkBudgetPoint;
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
  const [metric, setMetric] = useState<ScanMetric>('gainDb');
  const { inputPowerDbm, opticalSources } = conditions;
  const scan = useMemo(() => range && budget.scanNamedLink(link, range, { inputPowerDbm, opticalSources }),
    [budget, inputPowerDbm, opticalSources, link, range]);
  const selectedPoint = scan?.points.find(point => point.frequencyGHz === frequency);

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
    {trialControls}
    <div className="v1-single-point"><PointDetails point={single} labels={labels} locate={locate} /></div>
    {diagnostics}
    <details>
      <summary>射频扫描 · 1 GHz 步长</summary>
      <form onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const startGHz = Number(data.get('scanStart'));
        const stopGHz = Number(data.get('scanStop'));
        setRange({ startGHz, stopGHz });
        if (startGHz <= stopGHz) setFrequency(startGHz);
      }}>
        <div className="v1-link-fields">
          <label>起始频率 (GHz)<input name="scanStart" type="number" min={0} max={67} defaultValue={0} step={1} required /></label>
          <label>终止频率 (GHz)<input name="scanStop" type="number" min={0} max={67} defaultValue={67} step={1} required /></label>
        </div>
        <button type="submit">运行扫描</button>
      </form>
      {scan?.status === 'invalid_range' && <p className="error" role="alert">{scan.reason}</p>}
      {scan?.status === 'complete' && <>
        <div className="v1-link-fields">
          <label>曲线指标<select value={metric} onChange={event => setMetric(event.target.value as ScanMetric)}>
            {Object.entries(scanMetrics).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
          <label>查看频点<select name="scanPoint" value={selectedPoint?.frequencyGHz ?? ''}
            onChange={event => setFrequency(Number(event.target.value))}>
            {!selectedPoint && <option value="" disabled>请选择扫描频点</option>}
            {scan.points.map(point => <option key={point.frequencyGHz} value={point.frequencyGHz}>
              {point.frequencyGHz} GHz · {statusLabels[point.status]}{point.kind === 'conversion' && point.segments.some(s => s.extrapolated) && ' · 线性外推'}
            </option>)}
          </select></label>
        </div>
        <RfScanPlot points={scan.points} metric={metric} selected={frequency} />
        {selectedPoint && <div className="v1-scan-point"><PointDetails point={selectedPoint} labels={labels} locate={locate} /></div>}
      </>}
    </details>
  </section>;
}
