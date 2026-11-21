import { useState } from 'react';
import type { PortDefinition, PortDirection, PortType } from '../../../model/v1/types';
import { portTypeLabels } from '../labels';
import { ChannelField } from './channel-field';
import { InputRatingField, ratingUnits, readInputRating } from './input-rating-field';
import { OutputVoltageField, readOutputVoltage } from './output-voltage-field';
import { channelList } from './value-fields';

export function AddPortDialog({ name, locations, add, close }: {
  name: string;
  locations: readonly string[];
  add: (port: PortDefinition) => string | undefined;
  close: () => void;
}) {
  const [error, setError] = useState('');
  const [type, setType] = useState<PortType>('RF');
  const [direction, setDirection] = useState<PortDirection>('in');
  const optical = type === 'OPTICAL';
  const ratings = ratingUnits(type, direction);
  const dcOutput = type === 'DC_POWER' && direction === 'out';
  return <dialog ref={dialog => { if (dialog && !dialog.open) dialog.showModal(); }}
    className="v1-topology-dialog v1-add-port-dialog" aria-labelledby="add-port-title" onCancel={close}>
    <h3 id="add-port-title">添加端口 · {name}</h3>
    {locations.length > 0 && <p>端口属于共享定义，以下实例将同时新增端口：{locations.join('、')}。</p>}
    <form onChange={() => { if (error) setError(''); }} onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const result = add({ id: crypto.randomUUID(), name: String(data.get('name')),
        type, direction,
        channelIds: optical ? channelList(data, 'channels') : undefined,
        inputRating: readInputRating(data, ratings),
        outputVoltageV: dcOutput ? readOutputVoltage(data) : undefined,
      });
      if (result) setError(result);
      else close();
    }}>
      <label>端口名称<input name="name" required autoFocus /></label>
      <div className="v1-port-choices">
        <fieldset className="v1-port-radio-group">
          <legend>类型</legend>
          {Object.entries(portTypeLabels).map(([value, label]) => <label key={value}>
            <input type="radio" name="type" value={value} checked={type === value} onChange={() => setType(value as PortType)} />{value} · {label}
          </label>)}
        </fieldset>
        <fieldset className="v1-port-radio-group">
          <legend>方向</legend>
          <label><input type="radio" name="direction" value="in" checked={direction === 'in'} onChange={() => setDirection('in')} />输入</label>
          <label><input type="radio" name="direction" value="out" checked={direction === 'out'} onChange={() => setDirection('out')} />输出</label>
        </fieldset>
        <fieldset className="v1-port-parameters">
          <legend>端口参数</legend>
          {optical && <ChannelField name="channels" label="适用通道（未选择表示不限）" multiple />}
          {ratings.length > 0 && <InputRatingField key={ratings.join('/')} units={ratings} />}
          {dcOutput && <OutputVoltageField />}
          {!optical && !ratings.length && !dcOutput && <p className="v1-property-effective">无需额外参数</p>}
        </fieldset>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button type="submit">添加端口</button>
        <button type="button" onClick={close}>取消</button>
      </div>
    </form>
  </dialog>;
}
