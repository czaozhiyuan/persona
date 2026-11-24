import { editablePortName, portDisplayName, portTypeLabels } from '../labels';
import { useState } from 'react';
import { receiverMode } from '../../../engine/v1/receiver-response';
import { usesReceiverField } from './receiver-properties';
import { receiverModes } from '../../../model/v1/device';
import { resolveEmpiricalValue } from '../../../engine/v1/empirical-value';
import type { ResolvedInstance } from '../../../engine/v1/hierarchy';
import type { ComponentDefinition, PortDefinition, PortDirection, PortType } from '../../../model/v1/types';
import type { Transfer } from '../../../model/v1/device';
import { CapacityField, readCapacity } from './dc-fields';
import { AutosaveForm } from './autosave-form';
import { ChannelField } from './channel-field';
import { InputRatingField, ratingUnits, readInputRating } from './input-rating-field';
import { OutputVoltageField, readOutputVoltage } from './output-voltage-field';
import { channelId, channelList, choice, enumLabel, opticalKinds, QuantityField, readQuantity, rfKinds } from './value-fields';

export function readPort(data: FormData, port: PortDefinition): PortDefinition {
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
  const name = choice(data, 'name').trim();
  return {
    ...port, name: name === editablePortName(port) ? port.name : name || undefined, type, direction, channelIds,
    inputRating: sameRating ? previousRating : inputRating,
    opticalEmitter: type === 'OPTICAL' && direction === 'out' && data.get('emitter') === 'yes'
      ? { powerDbm: readQuantity(data, 'sourcePower', opticalKinds) } : undefined,
    outputVoltageV: type === 'DC_POWER' && direction === 'out' ? readOutputVoltage(data) : undefined,
  };
}

export function PortFields({ port, occurrence, save, remove }: {
  port: PortDefinition; occurrence: ResolvedInstance; save: (port: PortDefinition) => boolean; remove: () => void;
}) {
  const version = JSON.stringify(port);
  return <AutosaveForm version={version} save={data => {
    const next = readPort(data, port);
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
    <label>显示名称<input name="name" defaultValue={editablePortName(port)} placeholder={portDisplayName(port)} /></label>
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

function readReceiver(value: string) {
  return value.startsWith('param:') ? { kind: 'parameter' as const, parameterId: value.slice(6) }
    : receiverModes.find(mode => mode === value);
}

export function readTransfer(data: FormData, transfer: Transfer): Transfer {
  const ports = { fromPortId: choice(data, 'from'), toPortId: choice(data, 'to') };
  switch (transfer.kind) {
    case 'digitalTx': return { ...transfer, ...ports, channelIds: channelList(data, 'channels') };
    case 'digitalRx': return { ...transfer, ...ports, channelIds: channelList(data, 'channels'),
      sensitivityDbm: readQuantity(data, 'sensitivity', opticalKinds), overloadDbm: readQuantity(data, 'overload', opticalKinds) };
    case 'splitter': return { ...transfer, ...ports, secondPortId: choice(data, 'secondPort'),
      firstPercent: readQuantity(data, 'percent', ['fixed']), excessLossDb: readQuantity(data, 'excess', ['fixed']) };
    case 'rf': return { ...transfer, ...ports, gainDb: readQuantity(data, 'gain', rfKinds), nfDb: readQuantity(data, 'nf', rfKinds) };
    case 'optical': return { ...transfer, ...ports, channelIds: channelList(data, 'channels'), gainDb: readQuantity(data, 'gain', opticalKinds) };
    case 'eo': return { ...transfer, ...ports, channelIds: channelList(data, 'channels'), supplyPortId: choice(data, 'supply') || undefined,
      insertionLossDb: readQuantity(data, 'insertionLoss', opticalKinds), vPi: readQuantity(data, 'vPi', rfKinds) };
    case 'dml': return { ...transfer, ...ports, channelIds: channelList(data, 'channels'), modulationSlope: readQuantity(data, 'slope', rfKinds) };
    case 'oe': {
      return { ...transfer, ...ports, channelIds: channelList(data, 'channels'), receiver: readReceiver(choice(data, 'receiver')),
        responsivity: data.has('responsivityKind') ? readQuantity(data, 'responsivity', opticalKinds) : transfer.responsivity,
        responseDb: data.has('responseDbKind') ? readQuantity(data, 'responseDb', rfKinds) : transfer.responseDb,
        loadedGain: data.has('loadedGainKind') ? readQuantity(data, 'loadedGain', rfKinds) : transfer.loadedGain };
    }
    case 'wavelengthConversion': return { ...transfer, ...ports, fromChannelId: channelId(choice(data, 'fromChannel')),
      toChannelId: channelId(choice(data, 'toChannel')), gainDb: readQuantity(data, 'gain', opticalKinds) };
    case 'dc': return data.has('capacityUnit') ? { ...transfer, ...ports,
      efficiency: readQuantity(data, 'efficiency', ['fixed']), capacity: readCapacity(data) } : { ...transfer, ...ports };
  }
}

type TransferFieldProps = {
  draft?: boolean; occurrences?: readonly ResolvedInstance[];
  transfer: Transfer; definition: ComponentDefinition; save: (read: () => Transfer) => void | boolean;
};

export function TransferFields(props: TransferFieldProps) {
  const version = JSON.stringify(props.transfer);
  const [fields, setFields] = useState({ version, revision: 0 });
  // Preserve sibling drafts on a single curve commit. Reload the whole form after undo or replacement.
  if (fields.version !== version) setFields({ version, revision: fields.revision + 1 });
  return <TransferForm key={fields.revision} {...props} saveCurve={next => {
    if (props.save(() => next) !== false) setFields({ ...fields, version: JSON.stringify(next) });
  }} />;
}

function TransferForm({ transfer, definition, occurrences = [], save, draft, saveCurve }: TransferFieldProps & {
  saveCurve: (next: Transfer) => void;
}) {
  const receiver = transfer.kind === 'oe' ? transfer.receiver : undefined;
  const [selection, setSelection] = useState(typeof receiver === 'object' ? 'param:' + receiver.parameterId : receiver ?? '');
  const reference = readReceiver(selection);
  const modes = typeof reference === 'object'
    ? new Set(occurrences.filter(item => item.definition.id === definition.id).map(item => receiverMode(reference, item)))
    : new Set([reference]);
  const [mode] = modes;
  const mixed = modes.size > 1 || (!!draft && typeof reference === 'object');
  const inputType = transfer.kind === 'digitalTx' ? 'CONTROL' : transfer.kind === 'digitalRx' || transfer.kind === 'splitter' ? 'OPTICAL' : undefined;
  const outputType = transfer.kind === 'digitalRx' ? 'CONTROL' : transfer.kind === 'digitalTx' || transfer.kind === 'splitter' ? 'OPTICAL' : undefined;
  const inputPorts = definition.ports.filter(port => port.direction === 'in' && (!inputType || port.type === inputType));
  const outputPorts = definition.ports.filter(port => port.direction === 'out' && (!outputType || port.type === outputType));
  const parameters = definition.parameters ?? [];
  return <form onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    save(() => readTransfer(data, transfer));
  }}>
    <label>输入端口<select name="from" defaultValue={transfer.fromPortId} required>
      {inputPorts.map(port => <option key={port.id} value={port.id}>{portDisplayName(port, true, definition.ports)} · {portTypeLabels[port.type]}</option>)}
    </select></label>
    <label>输出端口<select name="to" defaultValue={transfer.toPortId} required>
      {outputPorts.map(port => <option key={port.id} value={port.id}>{portDisplayName(port, true, definition.ports)} · {portTypeLabels[port.type]}</option>)}
    </select></label>
    {(transfer.kind === 'optical' || transfer.kind === 'eo' || transfer.kind === 'dml' || transfer.kind === 'oe'
      || transfer.kind === 'digitalTx' || transfer.kind === 'digitalRx') &&
      <ChannelField name="channels" label="适用通道（未选择表示不限）" value={transfer.channelIds} multiple />}
    {transfer.kind === 'splitter' && <>
      <label>第二输出端口<select name="secondPort" defaultValue={transfer.secondPortId} required>
        {outputPorts.filter(port => port.type === 'OPTICAL').map(port => <option key={port.id} value={port.id}>{portDisplayName(port, true, definition.ports)}</option>)}
      </select></label>
      <QuantityField name="percent" label="第一输出分光比" unit="%" kinds={['fixed']} minimum={0} value={transfer.firstPercent} parameters={parameters} />
      <QuantityField name="excess" label="额外插损" kinds={['fixed']} minimum={0} value={transfer.excessLossDb} parameters={parameters} />
    </>}
    {transfer.kind === 'digitalRx' && <>
      <QuantityField name="sensitivity" label="接收灵敏度" unit="dBm" kinds={opticalKinds} value={transfer.sensitivityDbm} parameters={parameters} />
      <QuantityField name="overload" label="接收过载上限（可选）" unit="dBm" kinds={opticalKinds} value={transfer.overloadDbm} parameters={parameters} />
    </>}
    {transfer.kind === 'eo' && <label>供光输入<select name="supply" defaultValue={transfer.supplyPortId ?? ''}>
      <option value="">未设置</option>
      {inputPorts.filter(port => port.type === 'OPTICAL').map(port => <option key={port.id} value={port.id}>{portDisplayName(port, true, definition.ports)}</option>)}
    </select></label>}
    {transfer.kind === 'wavelengthConversion' && <div className="v1-property-pair">
      <ChannelField name="fromChannel" label="输入通道" value={transfer.fromChannelId} required />
      <ChannelField name="toChannel" label="输出通道" value={transfer.toChannelId} required />
    </div>}
    {transfer.kind === 'rf' && <>
      <QuantityField name="gain" label="增益" kinds={rfKinds} value={transfer.gainDb} parameters={parameters}
        onCurveApply={draft ? undefined : gainDb => saveCurve({ ...transfer, gainDb })} />
      <QuantityField name="nf" label="噪声系数" kinds={rfKinds} value={transfer.nfDb} parameters={parameters}
        onCurveApply={draft ? undefined : nfDb => saveCurve({ ...transfer, nfDb })} />
    </>}
    {transfer.kind === 'dml' && <>
      <QuantityField name="slope" label="加载 50 Ω 的直调系数 K(f)" unit="W/V" kinds={rfKinds}
        value={transfer.modulationSlope} parameters={parameters} minimum={0}
        onCurveApply={draft ? undefined : modulationSlope => saveCurve({ ...transfer, modulationSlope })} />
      <p>K 是交流光功率峰值与已加载 RF 电压峰值之比。已知斜率效率 η（W/A）和实际电流耦合 α（A/V）时，K = η × α。固定 K 按平坦频响计算。</p>
    </>}
    {transfer.kind === 'eo' && <>
      <QuantityField name="insertionLoss" label="最大透过状态光插损" kinds={opticalKinds}
        value={transfer.insertionLossDb} parameters={parameters} minimum={0} />
      <QuantityField name="vPi" label="RF 半波电压 Vπ" unit="V" kinds={rfKinds}
        value={transfer.vPi} parameters={parameters} minimum={Number.MIN_VALUE}
        onCurveApply={draft ? undefined : vPi => saveCurve({ ...transfer, vPi })} />
      <p>正交偏置自动计入 3.0103 dB 损耗。固定 Vπ 按平坦响应估算。</p>
    </>}
    {transfer.kind === 'oe' && <>
      <label>接收结构<select name="receiver" value={selection} onChange={event => setSelection(event.target.value)}>
        <option value="">未设置</option>
        {receiverModes.map(mode => <option key={mode} value={mode}>{enumLabel(mode)}</option>)}
        {parameters.filter(p => p.kind === 'enum' && p.options.every(o => receiverModes.some(m => m === o))).map(p =>
          <option key={p.id} value={'param:' + p.id}>引用参数 · {p.name}</option>)}
      </select></label>
      {mixed && <p>字段是否参与计算由实例接收结构决定。</p>}
      {!mode && !mixed && <p>先选择接收结构。{reference && '请设置引用参数的有效值。'}</p>}
      <QuantityField hidden={!mixed && !usesReceiverField(mode, 'responsivity')} name="responsivity"
        label={mode === 'active50' && !mixed ? '响应度（可选，仅用于平均光电流）' : '响应度'} unit="A/W" kinds={opticalKinds} value={transfer.responsivity} parameters={parameters} minimum={0} />
      <QuantityField hidden={!mixed && !usesReceiverField(mode, 'responseDb')} name="responseDb" label="无源 PD 归一化幅频响应（可选，未填按 0 dB 假定平坦）" kinds={rfKinds} value={transfer.responseDb} parameters={parameters}
        onCurveApply={draft ? undefined : responseDb => saveCurve({ ...transfer, responseDb })} />
      <QuantityField hidden={!mixed && !usesReceiverField(mode, 'loadedGain')} name="loadedGain" label="有源 RF 预算必填 · 加载转换增益 C(f)（外接 50 Ω）" unit="V/W" kinds={rfKinds} value={transfer.loadedGain} parameters={parameters}
        onCurveApply={draft ? undefined : loadedGain => saveCurve({ ...transfer, loadedGain })} />
    </>}
    {(transfer.kind === 'optical' || transfer.kind === 'wavelengthConversion') &&
      <QuantityField name="gain" label="增益" kinds={opticalKinds} value={transfer.gainDb} parameters={parameters} />}
    {draft && transfer.kind === 'dc' && <>
      <QuantityField name="efficiency" label="转换效率" kinds={['fixed']} unit="ratio" minimum={Number.MIN_VALUE}
        value={transfer.efficiency} parameters={parameters} />
      <CapacityField capacity={transfer.capacity} parameters={parameters} />
    </>}
    {!draft && <button type="submit">保存传输</button>}
  </form>;
}
