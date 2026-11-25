import { useState } from 'react';
import type { ResolvedInstance } from '../../../engine/v1/hierarchy';
import { isPowerPort, isSupplyOutput } from '../../../model/v1/types';
import type { PortDefinition, PortDirection, PortType } from '../../../model/v1/types';
import { portTypeLabels } from '../labels';
import { ChannelField } from './channel-field';
import { InputRatingField, ratingUnits, readInputRating } from './input-rating-field';
import { PortVoltageField, readPortVoltage, voltageParameters, voltageTitle } from './port-voltage-field';
import { readSupplyCapacity, SupplyCapacityField } from './dc-fields';
import { channelList } from './value-fields';

export function AddPortDialog({ name, owner, locations, add, close }: {
  owner: ResolvedInstance;
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
  const [reference, setReference] = useState('');
  const supply = isSupplyOutput(owner.definition, { type, direction });
  const voltageOptions = supply ? [] : voltageParameters(owner.definition.parameters);
  const power = isPowerPort(type);
  return <dialog ref={dialog => { if (dialog && !dialog.open) dialog.showModal(); }}
    className="v1-topology-dialog v1-add-port-dialog" aria-labelledby="add-port-title" onCancel={close}>
    <h3 id="add-port-title">添加端口 · {name}</h3>
    {locations.length > 0 && <p>端口属于共享定义，以下实例将同时新增端口：{locations.join('、')}。</p>}
    <form onChange={() => { if (error) setError(''); }} onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const result = add({ id: crypto.randomUUID(), name: power ? undefined : String(data.get('name')),
        type, direction,
        channelIds: optical ? channelList(data, 'channels') : undefined,
        inputRating: readInputRating(data, ratings),
        supplyCapacity: supply ? readSupplyCapacity(data) : undefined,
        inputVoltageV: power && direction === 'in' ? readPortVoltage(data, direction) : undefined,
        outputVoltageV: power && direction === 'out' ? readPortVoltage(data, direction) : undefined,
      });
      if (result) setError(result);
      else close();
    }}>
      {!power && <label>端口名称<input name="name" required autoFocus /></label>}
      <div className="v1-port-choices">
        <fieldset className="v1-port-radio-group">
          <legend>类型</legend>
          {Object.entries(portTypeLabels).map(([value, label]) => <label key={value}>
            <input type="radio" name="type" value={value} checked={type === value} onChange={() => { setType(value as PortType); setReference(''); }} />{value} · {label}
          </label>)}
        </fieldset>
        <fieldset className="v1-port-radio-group">
          <legend>方向</legend>
          <label><input type="radio" name="direction" value="in" checked={direction === 'in'} onChange={() => { setDirection('in'); setReference(''); }} />输入</label>
          <label><input type="radio" name="direction" value="out" checked={direction === 'out'} onChange={() => { setDirection('out'); setReference(''); }} />输出</label>
        </fieldset>
        <fieldset className="v1-port-parameters">
          <legend>端口参数</legend>
          {optical && <ChannelField name="channels" label="适用通道（未选择表示不限）" multiple />}
          {ratings.length > 0 && <InputRatingField key={ratings.join('/')} units={ratings} />}
          {power && !!voltageOptions.length && <label>{voltageTitle(type, direction)}来源
            <select name={direction === 'in' ? 'inputVoltageParameter' : 'outputVoltageParameter'} value={reference} onChange={e => setReference(e.target.value)}>
              <option value="">固定值或留空</option>{voltageOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>}
          {power && !reference && <PortVoltageField key={type + direction} type={type} direction={direction} />}
          {supply && <SupplyCapacityField />}
          {!optical && !ratings.length && !power && <p className="v1-property-effective">无需额外参数</p>}
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
