import { useMemo } from 'react';
import { calculateDcBudget } from '../../../engine/v1/dc-budget';
import type { DcBudget } from '../../../engine/v1/dc-budget';
import type { EndpointRef, InstancePath, Project } from '../../../model/v1/types';
import type { LinkOptions } from '../links/link-options';
import { enclosureContains, EndpointLocation } from './budget-location';
import { Metric, Rating } from './budget-values';

type Output = DcBudget['supplies'][number];

const diagnosticLabels = {
  open_input: '尚未连接', feedback: '变换反馈',
  missing_parameter: '缺少参数', unknown_load: '负载未知', voltage_conflict: '电压不一致',
};

function OutputColumns({ output }: { output: Output }) {
  return <>
    <td><Metric metric={output.voltageV} /></td>
    <td data-metric="dc-demand"><Metric metric={output.demandW} /></td>
    <td data-metric="dc-known"><Metric metric={output.knownDemandW} /></td>
    <td data-metric="dc-capacity"><Metric metric={output.capacityW} /></td>
    <td data-metric="dc-margin">
      {output.capacityStatus === 'over_capacity' && output.marginW.availability === 'available'
        ? <strong className="v1-budget-warning">超载 {(-output.marginW.value).toFixed(1)} W</strong>
        : <Metric metric={output.marginW} />}
    </td>
  </>;
}

function OutputHead() {
  return <><th>网络电压</th><th>总负载</th><th>已知负载小计</th><th>总容量</th><th>容量余量</th></>;
}

export function DcBudgetPanel({ project, labels: { showEndpoint, showPort, showPath }, scope, locate }: {
  project: Project; labels: Pick<LinkOptions, 'showEndpoint' | 'showPort' | 'showPath'>; scope?: InstancePath;
  locate: (endpoint: EndpointRef) => void;
}) {
  const full = useMemo(() => calculateDcBudget(project), [project]);
  const inside = scope ? enclosureContains(project, scope) : undefined;
  const include = ({ endpoint }: { endpoint: EndpointRef }) => !inside || inside(endpoint.instancePath);
  const budget = {
    networks: full.networks.filter(network => !inside || network.ports.some(p => inside(p.instancePath))),
    ports: full.ports.filter(include), supplies: full.supplies.filter(include),
    converters: full.converters.filter(item => include(item.output)),
    loads: full.loads.filter(include), diagnostics: full.diagnostics.filter(include),
  };
  const ratings = budget.ports.flatMap(port => port.rating ? [port.rating] : []);
  return <section className="panel v1-budget-report" aria-labelledby="v1-dc-heading">
    <h2 id="v1-dc-heading">供电预算</h2>
    {scope && <p>机箱范围 · {showPath(scope)}。跨机箱网络显示整网合计。</p>}
    {!budget.ports.length && <p className="empty">当前范围没有供电端口。</p>}
    {budget.networks.length > 0 && <div className="v1-budget-table"><table>
      <caption>供电网络</caption><thead><tr><th>类型与代表端口</th><OutputHead /><th>已知容量小计</th><th>容量状态</th></tr></thead>
      <tbody>{budget.networks.map(net => <tr key={JSON.stringify(net.endpoint)} data-power-network={net.type}>
        <th scope="row">{net.type === 'AC_POWER' ? '交流 RMS' : '直流'} · <EndpointLocation endpoint={net.endpoint}
          label={showEndpoint(net.endpoint)} locate={locate} />（{net.sources.length} 路来源）</th>
        <OutputColumns output={net} /><td><Metric metric={net.knownCapacityW} /></td>
        <td>{net.capacityStatus === 'within_capacity' ? '充足' : net.capacityStatus === 'over_capacity' ? '超载' : '待确认'}</td>
      </tr>)}</tbody>
    </table></div>}
    {budget.networks.some(net => net.sources.length > 1) && <p>并联网络按各路额定容量合计。电压冲突时，已知额定功率仅作理论小计。</p>}
    {budget.networks.some(net => net.type === 'AC_POWER' && net.sources.length > 1) && <p>交流并联采用理想模型，相位和同步条件未经验证。</p>}
    {budget.supplies.length > 0 && <div className="v1-budget-table"><table>
      <caption>电源额定容量</caption><thead><tr><th>实例输出端口</th><th>额定容量</th></tr></thead>
      <tbody>{budget.supplies.map(output => <tr key={JSON.stringify(output.endpoint)}>
        <th scope="row"><EndpointLocation endpoint={output.endpoint} label={showEndpoint(output.endpoint)} locate={locate} /></th><td><Metric metric={output.capacityW} /></td>
      </tr>)}</tbody>
    </table></div>}
    {budget.converters.length > 0 && <div className="v1-budget-table"><table>
      <caption>直流变换器（DC/DC）</caption><thead><tr><th>实例输入 → 输出</th><th>效率</th><th>输入需求</th><th>输出额定容量</th></tr></thead>
      <tbody>{budget.converters.map(item => <tr key={JSON.stringify([item.input, item.output.endpoint])}>
        <th scope="row"><EndpointLocation endpoint={item.input} label={showEndpoint(item.input)} locate={locate} /> → {showPort(item.output.endpoint)}</th>
        <td><Metric metric={item.efficiency} /></td><td data-metric="dc-input-demand"><Metric metric={item.inputDemandW} /></td>
        <td><Metric metric={item.output.capacityW} /></td>
      </tr>)}</tbody>
    </table></div>}
    {budget.loads.length > 0 && <div className="v1-budget-table"><table>
      <caption>负载</caption><thead><tr><th>实例输入端口</th><th>负载功率</th></tr></thead>
      <tbody>{budget.loads.map(load => <tr key={JSON.stringify(load.endpoint)}>
        <th scope="row"><EndpointLocation endpoint={load.endpoint} label={showEndpoint(load.endpoint)} locate={locate} /></th><td><Metric metric={load.powerW} /></td>
      </tr>)}</tbody>
    </table></div>}
    {ratings.length > 0 && <div className="v1-budget-table"><table>
      <caption>输入额定检查</caption><thead><tr><th>输入端口</th><th>检查结果</th></tr></thead>
      <tbody>{ratings.map(check => <tr key={JSON.stringify(check.endpoint)}>
        <th scope="row"><EndpointLocation endpoint={check.endpoint} label={showEndpoint(check.endpoint)} locate={locate} /></th>
        <td>{check.status === 'within_range' ? '在额定范围内' : <Rating check={check} />}</td>
      </tr>)}</tbody>
    </table></div>}
    {budget.diagnostics.length > 0 && <>
      <h3>诊断</h3>
      <ul className="v1-budget-reasons">{budget.diagnostics.map((item, index) => <li key={index} data-dc-diagnostic={item.code}>
        <strong>{diagnosticLabels[item.code]}</strong> · <EndpointLocation endpoint={item.endpoint} label={showEndpoint(item.endpoint)} locate={locate} /> · {item.reason}
      </li>)}</ul>
    </>}
  </section>;
}
