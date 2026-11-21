import { portDisplayName, portTypeLabels } from '../labels';
import { receiverModes } from '../../../model/v1/device';
import { resolveEmpiricalValue } from '../../../engine/v1/empirical-value';
import type { ResolvedInstance } from '../../../engine/v1/hierarchy';
import type { ComponentDefinition, PortDefinition, PortDirection, PortType } from '../../../model/v1/types';
import type { Transfer } from '../../../model/v1/device';
import { AutosaveForm } from './autosave-form';
import { ChannelField } from './channel-field';
import { InputRatingField, ratingUnits, readInputRating } from './input-rating-field';
import { OutputVoltageField, readOutputVoltage } from './output-voltage-field';
import { channelId, channelList, choice, enumLabel, opticalKinds, QuantityField, readQuantity, rfKinds } from './value-fields';

export function PortFields({ port, occurrence, save, remove }: {
  port: PortDefinition; occurrence: ResolvedInstance; save: (port: PortDefinition) => boolean; remove: () => void;
}) {
  const version = JSON.stringify(port);
  return <AutosaveForm version={version} save={data => {
    const type = choice(data, 'type') as PortType;
    const direction = choice(data, 'direction') as PortDirection;
    // The form still contains the previous rating controls during a type or direction change.
    const inputRating = type === port.type && direction === port.direction
      ? readInputRating(data, ratingUnits(type, direction)) : undefined;
    const channels = type === 'OPTICAL' ? channelList(data, 'channels') : undefined;
    const previousChannels = port.channelIds;
    const channelIds = channels?.length === previousChannels?.length
      && channels?.every(channel => previousChannels?.includes(channel)) ? previousChannels : channels;
    const previousRating = port.inputRating;
    const sameRating = inputRating?.unit === previousRating?.unit
      && inputRating?.min === previousRating?.min && inputRating?.max === previousRating?.max;
    const next: PortDefinition = {
      ...port, name: choice(data, 'name').trim() || undefined, type, direction, channelIds,
      inputRating: sameRating ? previousRating : inputRating,
      opticalEmitter: type === 'OPTICAL' && direction === 'out' && data.get('emitter') === 'yes'
        ? { powerDbm: readQuantity(data, 'sourcePower', opticalKinds) } : undefined,
      outputVoltageV: type === 'DC_POWER' && direction === 'out' ? readOutputVoltage(data) : undefined,
    };
    const nextVersion = JSON.stringify(next);
    if (nextVersion !== version && save(next)) return nextVersion;
  }}>
    <PortControls port={port} occurrence={occurrence} remove={remove} />
  </AutosaveForm>;
}

function PortControls({ port, occurrence, remove }: { port: PortDefinition; occurrence: ResolvedInstance; remove: () => void }) {
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
    {type === 'OPTICAL' && direction === 'out' && occurrence.definition.kind === 'component' && <>
      <label>光源端口<select name="emitter" defaultValue={port.opticalEmitter ? 'yes' : ''}>
        <option value="">普通光输出</option><option value="yes">连续光源输出</option>
      </select></label>
      {port.opticalEmitter && <QuantityField name="sourcePower" label="平均信号光功率" unit="dBm" kinds={opticalKinds}
        value={port.opticalEmitter.powerDbm} parameters={occurrence.definition.parameters ?? []} />}
    </>}
    {ratings.length > 0 && <InputRatingField key={type} units={ratings} rating={port.inputRating} />}
    {type === 'DC_POWER' && direction === 'out' && <PortVoltage port={port} occurrence={occurrence} />}
    <div className="actions">
      <button type="button" onClick={remove}>预览删除端口</button>
    </div>
  </>;
}

function PortVoltage({ port, occurrence }: { port: PortDefinition; occurrence: ResolvedInstance }) {
  const value = port.outputVoltageV;
  const parameters = occurrence.definition.parameters?.filter(parameter =>
    parameter.kind === 'numeric' && parameter.unit === 'V' && parameter.valueKind === 'fixed'
    && (parameter.range?.min ?? 0) > 0) ?? [];
  const parameterId = value?.kind === 'parameter' ? value.parameterId : '';
  const effective = parameterId ? resolveEmpiricalValue('V', value, {}, occurrence) : undefined;
  return <>
    {!!parameters.length && <label>输出电压来源
      <select name="outputVoltageParameter" value={parameterId} onChange={() => { /* Saved by the form's change handler. */ }}>
        <option value="">固定值或留空</option>
        {parameters.map(parameter => <option key={parameter.id} value={parameter.id}>{parameter.name}</option>)}
      </select>
    </label>}
    {effective ? <p className="v1-property-effective">输出电压 (V) · {
      effective.availability === 'available' ? effective.value : '未设置'
    }</p> : <OutputVoltageField value={value?.kind === 'fixed' ? value.value : undefined} />}
  </>;
}

function readTransfer(data: FormData, transfer: Transfer): Transfer {
  const ports = { fromPortId: choice(data, 'from'), toPortId: choice(data, 'to') };
  switch (transfer.kind) {
    case 'rf': return { ...transfer, ...ports, gainDb: readQuantity(data, 'gain', rfKinds), nfDb: readQuantity(data, 'nf', rfKinds) };
    case 'optical': return { ...transfer, ...ports, channelIds: channelList(data, 'channels'), gainDb: readQuantity(data, 'gain', opticalKinds) };
    case 'eo': return { ...transfer, ...ports, channelIds: channelList(data, 'channels'), supplyPortId: choice(data, 'supply') || undefined,
      insertionLossDb: readQuantity(data, 'insertionLoss', opticalKinds), vPi: readQuantity(data, 'vPi', rfKinds) };
    case 'oe': {
      const mode = choice(data, 'receiver');
      const receiver = mode.startsWith('param:') ? { kind: 'parameter' as const, parameterId: mode.slice(6) }
        : receiverModes.find(item => item === mode);
      return { ...transfer, ...ports, channelIds: channelList(data, 'channels'), receiver,
        responsivity: readQuantity(data, 'responsivity', opticalKinds), responseDb: readQuantity(data, 'responseDb', rfKinds),
        loadedGain: readQuantity(data, 'loadedGain', rfKinds) };
    }
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
      <QuantityField name="insertionLoss" label="最大透过状态光插损" kinds={opticalKinds}
        value={transfer.insertionLossDb} parameters={parameters} minimum={0} />
      <QuantityField name="vPi" label="RF 半波电压 Vπ" unit="V" kinds={rfKinds}
        value={transfer.vPi} parameters={parameters} minimum={Number.MIN_VALUE} />
      <p>正交偏置自动计入 3.0103 dB 损耗。固定 Vπ 按平坦响应估算。</p>
    </>}
    {transfer.kind === 'oe' && <>
      <label>接收结构<select name="receiver" defaultValue={typeof transfer.receiver === 'object'
        ? 'param:' + transfer.receiver.parameterId : transfer.receiver ?? ''}>
        <option value="">未设置</option>
        {receiverModes.map(mode => <option key={mode} value={mode}>{enumLabel(mode)}</option>)}
        {parameters.filter(p => p.kind === 'enum' && p.options.every(o => receiverModes.some(m => m === o))).map(p =>
          <option key={p.id} value={'param:' + p.id}>引用参数 · {p.name}</option>)}
      </select></label>
      <QuantityField name="responsivity" label="响应度" unit="A/W" kinds={opticalKinds} value={transfer.responsivity} parameters={parameters} minimum={0} />
      <QuantityField name="responseDb" label="无源 PD 归一化幅频响应（未填按平坦 0 dB）" kinds={rfKinds} value={transfer.responseDb} parameters={parameters} />
      <QuantityField name="loadedGain" label="有源接收机外接 50 Ω 的转换增益" unit="V/W" kinds={rfKinds} value={transfer.loadedGain} parameters={parameters} />
    </>}
    {(transfer.kind === 'optical' || transfer.kind === 'wavelengthConversion') &&
      <QuantityField name="gain" label="增益" kinds={opticalKinds} value={transfer.gainDb} parameters={parameters} />}
    <button type="submit">保存传输</button>
  </form>;
}
