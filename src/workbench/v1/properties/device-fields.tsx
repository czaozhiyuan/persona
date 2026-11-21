import { portDisplayName, portTypeLabels } from '../labels';
import { useState } from 'react';
import type { ComponentDefinition, PortDefinition, PortDirection, PortType } from '../../../model/v1/types';
import type { InputRating, Transfer } from '../../../model/v1/device';
import { AutosaveForm } from './autosave-form';
import { ChannelField } from './channel-field';
import { channelId, channelList, choice, numberField, opticalKinds, QuantityField, readQuantity, rfKinds } from './value-fields';

export function PortFields({ port, save, remove }: {
  port: PortDefinition; save: (port: PortDefinition) => boolean; remove: () => void;
}) {
  const version = JSON.stringify(port);
  return <AutosaveForm version={version} save={data => {
    const type = choice(data, 'type') as PortType;
    const direction = choice(data, 'direction') as PortDirection;
    // The form still contains the previous rating controls during a type or direction change.
    const unit = type === port.type && direction === port.direction
      ? ratingUnits(type, direction).find(candidate => candidate === choice(data, 'ratingUnit')) : undefined;
    const min = unit === undefined ? undefined : numberField(data, 'minimum');
    const max = unit === undefined ? undefined : numberField(data, 'maximum');
    const channels = type === 'OPTICAL' ? channelList(data, 'channels') : undefined;
    const previousChannels = port.channelIds;
    const channelIds = channels?.length === previousChannels?.length
      && channels?.every(channel => previousChannels?.includes(channel)) ? previousChannels : channels;
    const previousRating = port.inputRating;
    const inputRating = unit === previousRating?.unit && min === previousRating?.min && max === previousRating?.max
      ? previousRating
      : unit !== undefined && (min !== undefined || max !== undefined) ? { unit, min, max } : undefined;
    const next: PortDefinition = {
      ...port, name: choice(data, 'name').trim() || undefined, type, direction, channelIds, inputRating,
    };
    const nextVersion = JSON.stringify(next);
    if (nextVersion !== version && save(next)) return nextVersion;
  }}>
    <PortControls port={port} remove={remove} />
  </AutosaveForm>;
}

function ratingUnits(type: PortType, direction: PortDirection): readonly InputRating['unit'][] {
  if (direction !== 'in' || type === 'CONTROL') return [];
  return type === 'DC_POWER' ? ['V', 'A', 'W'] : ['dBm'];
}

function PortControls({ port, remove }: { port: PortDefinition; remove: () => void }) {
  const { type, direction } = port;
  const ratings = ratingUnits(type, direction);
  return <>
    <label>显示名称<input name="name" defaultValue={port.name} placeholder={port.id} /></label>
    <label>端口类型<select name="type" value={type} onChange={() => { /* Saved by the form's change handler. */ }}>
      {Object.entries(portTypeLabels).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
    </select></label>
    <label>方向<select name="direction" value={direction} onChange={() => { /* Saved by the form's change handler. */ }}>
      <option value="in">输入</option><option value="out">输出</option>
    </select></label>
    {type === 'OPTICAL' && <ChannelField name="channels" label="适用通道（未选择表示不限）" value={port.channelIds} multiple />}
    {ratings.length > 0 && <fieldset key={type}>
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
      <button type="button" onClick={remove}>预览删除端口</button>
    </div>
  </>;
}

function readTransfer(data: FormData, transfer: Transfer): Transfer {
  const ports = { fromPortId: choice(data, 'from'), toPortId: choice(data, 'to') };
  switch (transfer.kind) {
    case 'rf': return { ...transfer, ...ports, gainDb: readQuantity(data, 'gain', rfKinds), nfDb: readQuantity(data, 'nf', rfKinds) };
    case 'optical': return { ...transfer, ...ports, channelIds: channelList(data, 'channels'), gainDb: readQuantity(data, 'gain', opticalKinds) };
    case 'eo': {
      const split = choice(data, 'eoLossMode') === 'split';
      return { ...transfer, ...ports, channelIds: channelList(data, 'channels'),
        supplyPortId: choice(data, 'supply') || undefined,
        gainDb: split ? undefined : readQuantity(data, 'gain', opticalKinds),
        opticalLoss: split ? {
          intrinsicLossDb: readQuantity(data, 'intrinsicLoss', opticalKinds),
          operatingPointLossDb: readQuantity(data, 'operatingPointLoss', opticalKinds),
        } : undefined,
      };
    }
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
  const [eoLossMode, setEoLossMode] = useState(transfer.kind === 'eo' && transfer.gainDb !== undefined ? 'net' : 'split');
  return <form onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    save(() => readTransfer(data, transfer));
  }}>
    <label>输入端口<select name="from" defaultValue={transfer.fromPortId} required>
      {inputPorts.map(port => <option key={port.id} value={port.id}>{portDisplayName(port, true)} · {portTypeLabels[port.type]}</option>)}
    </select></label>
    <label>输出端口<select name="to" defaultValue={transfer.toPortId} required>
      {outputPorts.map(port => <option key={port.id} value={port.id}>{portDisplayName(port, true)} · {portTypeLabels[port.type]}</option>)}
    </select></label>
    {(transfer.kind === 'optical' || transfer.kind === 'eo' || transfer.kind === 'oe') &&
      <ChannelField name="channels" label="适用通道（未选择表示不限）" value={transfer.channelIds} multiple />}
    {transfer.kind === 'eo' && <label>供光输入<select name="supply" defaultValue={transfer.supplyPortId ?? ''}>
      <option value="">未设置</option>
      {inputPorts.filter(port => port.type === 'OPTICAL').map(port => <option key={port.id} value={port.id}>{portDisplayName(port, true)}</option>)}
    </select></label>}
    {transfer.kind === 'wavelengthConversion' && <div className="v1-property-pair">
      <ChannelField name="fromChannel" label="输入通道" value={transfer.fromChannelId} required />
      <ChannelField name="toChannel" label="输出通道" value={transfer.toChannelId} required />
    </div>}
    {transfer.kind === 'rf' && <>
      <QuantityField name="gain" label="增益" kinds={rfKinds} value={transfer.gainDb} parameters={parameters} />
      <QuantityField name="nf" label="噪声系数" kinds={rfKinds} value={transfer.nfDb} parameters={parameters} />
    </>}
    {transfer.kind === 'eo' && <>
      <label>光学损耗设置<select name="eoLossMode" value={eoLossMode} onChange={event => setEoLossMode(event.target.value)}>
        <option value="split">独立插损</option>
        <option value="net">带符号净增益</option>
      </select></label>
      {eoLossMode === 'split' ? <>
        <QuantityField name="intrinsicLoss" label="固有插损" kinds={opticalKinds}
          value={transfer.opticalLoss?.intrinsicLossDb} parameters={parameters} minimum={0} />
        <QuantityField name="operatingPointLoss" label="控制点附加损耗" kinds={opticalKinds}
          value={transfer.opticalLoss?.operatingPointLossDb} parameters={parameters} minimum={0} />
      </> : <QuantityField name="gain" label="光学净增益" kinds={opticalKinds} value={transfer.gainDb} parameters={parameters} />}
    </>}
    {(transfer.kind === 'optical' || transfer.kind === 'wavelengthConversion') &&
      <QuantityField name="gain" label="增益" kinds={opticalKinds} value={transfer.gainDb} parameters={parameters} />}
    <button type="submit">保存传输</button>
  </form>;
}
