import type { EndpointRef, PortFlow } from '../../../model/v1/types';
import type { BudgetMetric } from '../../../engine/v1/budget-metric';
import type { MultiplexDirection, MultiplexPoint, MultiplexPower, MultiplexTotal } from '../../../engine/v1/multiplex-power';
import { signalPortKey } from '../../../engine/v1/signal-graph';

export function totalText(total: MultiplexTotal, digits: number) {
  const { known, partial } = total;
  if (known.availability === 'unavailable') return partial ? '未确定' : '无';
  return (partial ? '已知 ' : '') + (known.value === -Infinity ? '−∞' : known.value.toFixed(digits)) + ' dBm';
}
const flowLabel = { in: '入', out: '出' };
const portArrows = { top: { in: '↓', out: '↑' }, left: { in: '→', out: '←' }, right: { in: '←', out: '→' } };

export function portPowerLines(point: MultiplexPoint, side: keyof typeof portArrows) {
  return (['out', 'in'] as const).filter(flow => point.waves.some(w => w.flow === flow))
    .map(flow => `${portArrows[side][flow]} ${flowLabel[flow]} ${totalText(point[flow], 2)}`);
}
function waveText(power: BudgetMetric<'dBm'>) {
  return power.availability === 'available' ? (power.value === -Infinity ? '−∞' : power.value.toFixed(4)) + ' dBm' : power.reason;
}

export function WirePowerDetails({ power, directions }: { power: MultiplexPower; directions: readonly MultiplexDirection[] }) {
  const endpoint = (ref: EndpointRef, flow: PortFlow) => power.label(ref) + '（' + flowLabel[flow] + '）';
  return <details className="v1-multiplex-details">
    <summary>复用光 · 查看两端逐波功率</summary>
    {!directions.length && <p>没有活动通道。</p>}
    {directions.map(d => <section key={signalPortKey(d.from)}>
      <h4>{endpoint(d.from, d.fromFlow)} → {endpoint(d.to, d.toFlow)}</h4>
      <p>起始 {totalText(d.start, 4)} · 到达 {totalText(d.arrival, 4)} · 插损 {d.lossDb} dB</p>
      <table><thead><tr><th>光通道</th><th>起始功率</th><th>到达功率</th><th>来源</th></tr></thead><tbody>
        {d.waves.map(w => <tr key={w.channelId}><td>{w.channelId}</td><td>{waveText(w.power)}</td><td>{waveText(w.arrival)}</td>
          <td>{w.sources.map(power.label).join('、')}</td></tr>)}
      </tbody></table>
    </section>)}
  </details>;
}

export function MultiplexDetails({ power, endpoints, title = '复用光逐波功率' }: {
  power: MultiplexPower; endpoints: readonly EndpointRef[]; title?: string;
}) {
  const points = new Set(endpoints.map(ref => power.at(ref)).filter((p): p is MultiplexPoint => !!p));
  if (!points.size) return null;
  return <details className="v1-multiplex-details">
    <summary>{title}</summary>
    {[...points].map(p => <section key={signalPortKey(p.ref)}>
      <h4>{power.label(p.ref)}</h4>
      <p>出 {totalText(p.out, 4)} / 入 {totalText(p.in, 4)}</p>
      {p.waves.length > 0 && <table><thead><tr><th>方向</th><th>光通道</th><th>光功率</th><th>来源</th></tr></thead><tbody>
        {p.waves.map(w => <tr key={w.flow + w.channelId}><td>{flowLabel[w.flow]}</td>
          <td>{w.channelId}</td><td>{waveText(w.power)}</td><td>{w.sources.map(power.label).join('、')}</td></tr>)}
      </tbody></table>}
    </section>)}
  </details>;
}
