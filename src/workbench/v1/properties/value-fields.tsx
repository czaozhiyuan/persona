import { useState } from 'react';
import { resolveOpticalChannel } from '../../../model/v1/channels';
import type { OpticalChannelId } from '../../../model/v1/channels';
import type { EmpiricalValue, ParameterDefinition, ParameterValue } from '../../../model/v1/parameters';
import { ChannelField } from './channel-field';

export const choice = (data: FormData, name: string) => String(data.get(name) ?? '');
export const textField = (data: FormData, name: string) => choice(data, name).trim();

export function numberField(data: FormData, name: string, required = false): number | undefined {
  const value = textField(data, name);
  if (!value && !required) return undefined;
  const number = Number(value);
  if (!value || !Number.isFinite(number)) throw new Error('请输入有效数值。');
  return number;
}

export function channelId(value: string) {
  const channel = resolveOpticalChannel(value);
  if (!channel) throw new Error(`未知光通道：${value}`);
  return channel.id;
}

export function channelList(data: FormData, name: string) {
  const ids = data.getAll(name).map(value => channelId(String(value)));
  return ids.length ? ids : undefined;
}

function enumLabel(value: string): string {
  if (value === 'normal') return '正常（normal）';
  if (value === 'standby') return '待机（standby）';
  return value;
}

type ValueKind = EmpiricalValue['kind'];

export function formatValue(value?: ParameterValue, separator = '\n'): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return enumLabel(value);
  switch (value.kind) {
    case 'fixed': return String(value.value);
    case 'rfCurve': return value.points.map(row => row.join(', ')).join(separator);
    case 'channelTable': return Object.entries(value.values).map(row => row.join(', ')).join(separator);
  }
}

function tableRows(source: string): [string, number][] {
  return source.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    const [key, raw, ...extra] = line.split(/[,，]/).map(cell => cell.trim());
    if (!key || !raw || extra.length || !Number.isFinite(Number(raw))) {
      throw new Error(`第 ${index + 1} 行需要一对以逗号分隔的有效值。`);
    }
    return [key, Number(raw)];
  });
}

export function readEmpirical<K extends ValueKind>(data: FormData, name: string, kind: K): Extract<EmpiricalValue, { kind: K }> | undefined;
export function readEmpirical(data: FormData, name: string, kind: ValueKind): EmpiricalValue | undefined {
  if (kind === 'channelTable') {
    const ids = data.getAll(name + 'Channel').map(value => channelId(String(value)));
    if (!ids.length) return undefined;
    if (new Set(ids).size !== ids.length) throw new Error('光通道表有重复通道。');
    const amounts = data.getAll(name + 'Amount');
    const values = ids.map((id, i) => {
      const raw = String(amounts[i] ?? '').trim();
      if (!raw || !Number.isFinite(Number(raw))) throw new Error('请输入有效的通道表数值。');
      return [id, Number(raw)] as const;
    });
    return { kind, values: Object.fromEntries(values) };
  }
  const raw = textField(data, name);
  if (!raw) return undefined;
  if (kind === 'fixed') return { kind, value: numberField(data, name, true)! };
  const rows = tableRows(raw);
  return { kind, points: rows.map(([frequency, value]) => [Number(frequency), value]) };
}

export function readParameter(data: FormData, name: string, parameter: ParameterDefinition): ParameterValue | undefined {
  return parameter.kind === 'enum' ? choice(data, name) || undefined : readEmpirical(data, name, parameter.valueKind);
}

export function EmpiricalField({ kind, name, label, value, required }: {
  kind: ValueKind; name: string; label: string; value?: EmpiricalValue; required?: boolean;
}) {
  if (kind === 'channelTable') return <ChannelTableField name={name} label={label}
    values={value?.kind === 'channelTable' ? value.values : undefined} required={required} />;
  const initial = value?.kind === kind ? formatValue(value) : '';
  return <label>{label}
    {kind === 'fixed' ? <input name={name} type="number" step="any" defaultValue={initial} required={required} />
      : <textarea name={name} rows={3} defaultValue={initial} required={required}
        placeholder="每行：频率 GHz, 数值" />}
  </label>;
}

function ChannelTableField({ name, label, values, required }: {
  name: string; label: string; values?: Partial<Record<OpticalChannelId, number>>; required?: boolean;
}) {
  const [rows, setRows] = useState<{ key: string; channel?: OpticalChannelId; amount?: number }[]>(() => {
    const entries = Object.entries(values ?? {}).map(([channel, amount], index) => ({
      key: String(index), channel: channelId(channel), amount,
    }));
    return entries.length || !required ? entries : [{ key: 'first', channel: undefined, amount: undefined }];
  });
  return <fieldset>
    <legend>{label}</legend>
    {rows.map(row => <div key={row.key} className="v1-property-pair">
      <ChannelField name={name + 'Channel'} label="通道" value={row.channel} required />
      <div>
        <label>数值<input name={name + 'Amount'} type="number" step="any" defaultValue={row.amount} required /></label>
        {(!required || rows.length > 1) && <button type="button" onClick={() => setRows(rows.filter(item => item.key !== row.key))}>移除此行</button>}
      </div>
    </div>)}
    <button type="button" onClick={() => setRows([...rows, { key: crypto.randomUUID(), channel: undefined, amount: undefined }])}>添加通道行</button>
  </fieldset>;
}

export function ParameterField({ parameter, value, label }: { parameter: ParameterDefinition; value?: ParameterValue; label: string }) {
  if (parameter.kind === 'enum') {
    return <label>{label}<select name="value" defaultValue={typeof value === 'string' ? value : ''}>
      <option value="">未设置</option>
      {parameter.options.map(option => <option key={option} value={option}>{enumLabel(option)}</option>)}
    </select></label>;
  }
  return <EmpiricalField name="value" kind={parameter.valueKind} label={`${label} (${parameter.unit})`}
    value={typeof value === 'string' ? undefined : value} />;
}

type Quantity<K extends ValueKind> = Extract<EmpiricalValue, { kind: K }> | { kind: 'parameter'; parameterId: string };

export function readQuantity<K extends ValueKind>(data: FormData, name: string, kinds: readonly K[]): Quantity<K> | undefined {
  const kind = textField(data, name + 'Kind');
  if (kind === 'parameter') return { kind, parameterId: choice(data, name) };
  const selected = kinds.find(item => item === kind);
  return selected && readEmpirical(data, name, selected);
}

export const rfKinds = ['fixed', 'rfCurve'] as const;
export const opticalKinds = ['fixed', 'channelTable'] as const;
const modeNames = { fixed: '固定值', rfCurve: '射频曲线折点', channelTable: '通道表', parameter: '引用参数' };

export function QuantityField({ name, label, kinds, value, parameters, minimum }: {
  name: string; label: string; kinds: readonly ValueKind[];
  value?: EmpiricalValue | { kind: 'parameter'; parameterId: string }; parameters: readonly ParameterDefinition[];
  minimum?: number;
}) {
  const [kind, setKind] = useState<ValueKind | 'parameter' | ''>(value?.kind ?? '');
  const options = parameters.filter(parameter =>
    parameter.kind === 'numeric' && parameter.unit === 'dB' && kinds.some(item => item === parameter.valueKind)
    && (minimum === undefined || (parameter.range?.min ?? -Infinity) >= minimum));
  return <fieldset>
    <legend>{label}</legend>
    <label>取值方式<select name={name + 'Kind'} value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
      <option value="">未设置</option>
      {kinds.map(item => <option key={item} value={item}>{modeNames[item]}</option>)}
      {options.length > 0 && <option value="parameter">{modeNames.parameter}</option>}
    </select></label>
    {kind === 'parameter' ? <label>参数<select name={name} defaultValue={value?.kind === 'parameter' ? value.parameterId : ''} required>
      <option value="">请选择</option>
      {options.map(parameter => <option key={parameter.id} value={parameter.id}>{parameter.name}</option>)}
    </select></label> : kind && <EmpiricalField key={kind} kind={kind} name={name} label="数值 (dB)" required
      value={value?.kind === 'parameter' ? undefined : value} />}
  </fieldset>;
}
