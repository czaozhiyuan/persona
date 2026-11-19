import { useState } from 'react';
import type { ComponentDefinition, PortDefinition, PortDirection, PortType } from '../../../model/v1/types';
import type { InputRating, Transfer } from '../../../model/v1/device';
import { ChannelField } from './channel-field';
import { channelId, channelList, choice, numberField, opticalKinds, QuantityField, readQuantity, rfKinds } from './value-fields';

export function PortFields({ port, save, remove }: {
  port: PortDefinition; save: (read: () => PortDefinition) => void; remove: () => void;
}) {
  const [type, setType] = useState(port.type);
  const [direction, setDirection] = useState(port.direction);
  const ratings: readonly InputRating['unit'][] = direction !== 'in' || type === 'CONTROL' ? []
    : type === 'DC_POWER' ? ['V', 'A', 'W'] : ['dBm'];
  return <form onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    save(() => {
      const min = numberField(data, 'minimum');
      const max = numberField(data, 'maximum');
      const unit = ratings.find(candidate => candidate === choice(data, 'ratingUnit'));
      return { ...port, type, direction, channelIds: type === 'OPTICAL' ? channelList(data, 'channels') : undefined,
        inputRating: unit !== undefined && (min !== undefined || max !== undefined) ? { unit, min, max } : undefined };
    });
  }}>
    <label>端口类型<select value={type} onChange={event => setType(event.target.value as PortType)}>
      <option>RF</option><option>OPTICAL</option><option>DC_POWER</option><option>CONTROL</option>
    </select></label>
    <label>方向<select value={direction} onChange={event => setDirection(event.target.value as PortDirection)}>
      <option value="in">输入</option><option value="out">输出</option>
    </select></label>
    {type === 'OPTICAL' && <ChannelField name="channels" label="适用通道（未选择表示不限）" value={port.channelIds} multiple />}
    {ratings.length > 0 && <fieldset key={ratings.join(',')}>
      <legend>输入额定范围（可选）</legend>
      <label>单位<select name="ratingUnit" defaultValue={ratings.includes(port.inputRating?.unit as InputRating['unit'])
        ? port.inputRating?.unit : ratings[0]}>
        {ratings.map(unit => <option key={unit}>{unit}</option>)}
      </select></label>
      <div className="v1-property-pair">
        <label>下限<input name="minimum" type="number" step="any" defaultValue={port.inputRating?.min} /></label>
        <label>上限<input name="maximum" type="number" step="any" defaultValue={port.inputRating?.max} /></label>
      </div>
    </fieldset>}
    <div className="actions">
      <button type="submit">保存端口属性</button>
      <button type="button" onClick={remove}>预览删除端口</button>
    </div>
  </form>;
}

function readTransfer(data: FormData, transfer: Transfer): Transfer {
  const ports = { fromPortId: choice(data, 'from'), toPortId: choice(data, 'to') };
  switch (transfer.kind) {
    case 'rf': return { ...transfer, ...ports, gainDb: readQuantity(data, 'gain', rfKinds), nfDb: readQuantity(data, 'nf', rfKinds) };
    case 'optical': return { ...transfer, ...ports, channelIds: channelList(data, 'channels'), gainDb: readQuantity(data, 'gain', opticalKinds) };
    case 'eo': return { ...transfer, ...ports, channelIds: channelList(data, 'channels'),
      supplyPortId: choice(data, 'supply') || undefined, gainDb: readQuantity(data, 'gain', opticalKinds) };
    case 'oe': return { ...transfer, ...ports, channelIds: channelList(data, 'channels') };
    case 'wavelengthConversion': return { ...transfer, ...ports, fromChannelId: channelId(choice(data, 'fromChannel')),
      toChannelId: channelId(choice(data, 'toChannel')), gainDb: readQuantity(data, 'gain', opticalKinds) };
    case 'dc': return { ...transfer, ...ports };
  }
}

export function TransferFields({ transfer, definition, save }: {
  transfer: Transfer; definition: ComponentDefinition; save: (read: () => Transfer) => void;
}) {
  const inputPorts = definition.ports.filter(port => port.direction === 'in');
  const outputPorts = definition.ports.filter(port => port.direction === 'out');
  const parameters = definition.parameters ?? [];
  return <form onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    save(() => readTransfer(data, transfer));
  }}>
    <label>输入端口<select name="from" defaultValue={transfer.fromPortId} required>
      {inputPorts.map(port => <option key={port.id} value={port.id}>{port.id} · {port.type}</option>)}
    </select></label>
    <label>输出端口<select name="to" defaultValue={transfer.toPortId} required>
      {outputPorts.map(port => <option key={port.id} value={port.id}>{port.id} · {port.type}</option>)}
    </select></label>
    {(transfer.kind === 'optical' || transfer.kind === 'eo' || transfer.kind === 'oe') &&
      <ChannelField name="channels" label="适用通道（未选择表示不限）" value={transfer.channelIds} multiple />}
    {transfer.kind === 'eo' && <label>供光输入<select name="supply" defaultValue={transfer.supplyPortId ?? ''}>
      <option value="">未设置</option>
      {inputPorts.filter(port => port.type === 'OPTICAL').map(port => <option key={port.id} value={port.id}>{port.id}</option>)}
    </select></label>}
    {transfer.kind === 'wavelengthConversion' && <div className="v1-property-pair">
      <ChannelField name="fromChannel" label="输入通道" value={transfer.fromChannelId} required />
      <ChannelField name="toChannel" label="输出通道" value={transfer.toChannelId} required />
    </div>}
    {transfer.kind === 'rf' && <>
      <QuantityField name="gain" label="增益" kinds={rfKinds} value={transfer.gainDb} parameters={parameters} />
      <QuantityField name="nf" label="噪声系数" kinds={rfKinds} value={transfer.nfDb} parameters={parameters} />
    </>}
    {(transfer.kind === 'optical' || transfer.kind === 'eo' || transfer.kind === 'wavelengthConversion') &&
      <QuantityField name="gain" label="增益" kinds={opticalKinds} value={transfer.gainDb} parameters={parameters} />}
    <button type="submit">保存传输</button>
  </form>;
}
