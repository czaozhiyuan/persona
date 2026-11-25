import type { EndpointRef } from '../../../model/v1/types';
import type { MultiplexPoint, MultiplexPower, MultiplexTotal } from '../../../engine/v1/multiplex-power';
import { signalPortKey } from '../../../engine/v1/signal-graph';

function totalText(total: MultiplexTotal, digits: number) {
  const { known, partial } = total;
  if (known.availability === 'unavailable') return partial ? '未确定' : '无';
  return (partial ? '已知 ' : '') + (known.value === -Infinity ? '−∞' : known.value.toFixed(digits));
}
export function multiplexCaption(point?: MultiplexPoint) {
  if (!point) return;
  return `复用光 发 ${totalText(point.out, 2)} / 收 ${totalText(point.in, 2)} dBm`;
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
      <p>发 {totalText(p.out, 4)} / 收 {totalText(p.in, 4)} dBm</p>
      {p.waves.length > 0 && <table><thead><tr><th>方向</th><th>光通道</th><th>光功率</th><th>来源</th></tr></thead><tbody>
        {p.waves.map(w => <tr key={w.flow + w.channelId}><td>{w.flow === 'out' ? '发' : '收'}</td>
          <td>{w.channelId}</td><td>{w.power.availability === 'available' ? (w.power.value === -Infinity ? '−∞' : w.power.value.toFixed(4)) + ' dBm'
            : w.power.reason}</td><td>{w.sources.map(power.label).join('、')}</td></tr>)}
      </tbody></table>}
    </section>)}
  </details>;
}
