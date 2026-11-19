import { useState } from 'react';
import type { OpticalSource } from '../../../engine/v1/optical-budget';
import { signalPortKey } from '../../../engine/v1/signal-graph';
import { resolveOpticalChannel } from '../../../model/v1/channels';
import type { LinkOptions } from './link-options';
import { showEndpoint } from './link-options';
import { ChannelField } from '../properties/channel-field';

const sourceKey = ({ endpoint, channelId }: OpticalSource) => JSON.stringify([signalPortKey(endpoint), channelId]);

export function LinkSupplyFields({ options, sources, onChange }: {
  options: LinkOptions['opticalSources'];
  sources: readonly OpticalSource[];
  onChange: (sources: readonly OpticalSource[]) => void;
}) {
  const [error, setError] = useState('');
  const labels = new Map(options.map(option => [option.key, option.label]));
  return <details>
    <summary>供光查询{sources.length ? ` · ${sources.length} 项` : ''}</summary>
    {sources.length > 0 && <ul className="v1-supply-list">
      {sources.map((source, index) => <li key={sourceKey(source)}>
        <span>{labels.get(signalPortKey(source.endpoint)) ?? showEndpoint(source.endpoint)} · <b>{source.channelId}</b></span>
        <label>光源功率 (dBm)<input type="number" step="any" value={source.powerDbm ?? ''} placeholder="未知"
          onChange={event => {
            const value = event.currentTarget.valueAsNumber;
            onChange(sources.map((item, at) => at === index ? {
              ...item, powerDbm: Number.isFinite(value) ? value : undefined,
            } : item));
          }} /></label>
        <button type="button" onClick={() => { setError(''); onChange(sources.filter((_, at) => at !== index)); }}>移除供光</button>
      </li>)}
    </ul>}
    <form onSubmit={event => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const endpoint = options.find(option => option.key === data.get('supplyEndpoint'))?.value;
      const channel = resolveOpticalChannel(String(data.get('supplyChannel') ?? ''));
      if (!endpoint || !channel) return;
      const power = data.get('supplyPower');
      const item: OpticalSource = { endpoint, channelId: channel.id,
        powerDbm: typeof power === 'string' && power !== '' ? Number(power) : undefined };
      if (sources.some(source => sourceKey(source) === sourceKey(item))) {
        setError('此端口和通道已添加，可在供光列表中修改功率。');
        return;
      }
      setError('');
      onChange([...sources, item]);
      form.reset();
    }}>
      <div className="v1-link-fields">
        <label>光源端口<select name="supplyEndpoint" required defaultValue="">
          <option value="">请选择端口</option>
          {options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
        </select></label>
        <ChannelField name="supplyChannel" label="供光通道" required />
        <label>光源功率 (dBm，可选)<input name="supplyPower" type="number" step="any" placeholder="未知" /></label>
      </div>
      <button type="submit" disabled={!options.length}>添加供光</button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  </details>;
}
