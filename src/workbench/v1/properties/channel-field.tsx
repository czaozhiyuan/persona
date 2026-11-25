import { useState } from 'react';
import { resolveOpticalChannel } from '../../../model/v1/channels';
import type { OpticalChannelId } from '../../../model/v1/channels';
import { wdmChannelPresets } from './channel-presets';

const presets: readonly OpticalChannelId[] = ['MM850', ...wdmChannelPresets];

export function ChannelField({ label, name, value, multiple, required }: {
  label: string; name: string; value?: OpticalChannelId | readonly OpticalChannelId[]; multiple?: boolean; required?: boolean;
}) {
  const existing = typeof value === 'string' ? [value] : value ?? [];
  const [query, setQuery] = useState('');
  const [extra, setExtra] = useState<readonly OpticalChannelId[]>([]);
  const options = [...new Set([...presets, ...existing, ...extra])];
  const candidate = resolveOpticalChannel(query.trim())?.id;
  return <div>
    <label>{label}
      <select name={name} multiple={multiple} size={multiple ? 4 : undefined} required={required}
        defaultValue={multiple ? [...existing] : existing[0] ?? ''}>
        {!multiple && <option value="">请选择通道</option>}
        {options.map(id => <option key={id} value={id}>{id}</option>)}
      </select>
    </label>
    <details>
      <summary>查找其他标准通道</summary>
      <label>标准通道 ID<input value={query} onChange={event => setQuery(event.target.value)} placeholder="例如 DWDM_CH31" /></label>
      <button type="button" disabled={!candidate || options.includes(candidate)} onClick={() => {
        if (candidate) setExtra([...extra, candidate]);
      }}>列入可选通道</button>
    </details>
  </div>;
}
