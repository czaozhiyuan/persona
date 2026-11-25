import { parameterValueKinds } from '../../../model/v1/parameters';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { resolveOpticalChannel } from '../../../model/v1/channels';
import type { OpticalChannelId } from '../../../model/v1/channels';
import type { EmpiricalValue, NumericParameter, NumericRange, NumericUnit, ParameterDefinition, ParameterValue, RfCurve } from '../../../model/v1/parameters';
import { ChannelField } from './channel-field';
import { RfCurveEditor } from './rf-curve-editor';

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

export function enumLabel(value: string): string {
  if (value === 'external50') return '光电流直接驱动外部 50 Ω';
  if (value === 'parallel50') return '内部并联 50 Ω，外接 50 Ω';
  if (value === 'active50') return '有源接收机（外接 50 Ω）';
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

export function readNumericParameter(data: FormData, name: string, parameter: NumericParameter) {
  const allowed = parameterValueKinds(parameter);
  const kind = allowed.find(kind => kind === data.get(name + 'Kind')) ?? allowed[0];
  // Previewing fixed mode leaves the saved curve in place until the number is edited.
  if (kind === 'fixed' && data.has(name + 'SavedCurve')) return readEmpirical(data, name + 'SavedCurve', 'rfCurve');
  return readEmpirical(data, name, kind);
}

export function readParameter(data: FormData, name: string, parameter: ParameterDefinition): ParameterValue | undefined {
  return parameter.kind === 'enum' ? choice(data, name) || undefined : readNumericParameter(data, name, parameter);
}

type CurveFieldProps = {
  title: string; scope: string; unit: NumericUnit; range?: NumericRange; inherited?: EmpiricalValue;
  kindInput?: string;
  onRfValueChange?: (value?: EmpiricalValue) => void;
  onCurveApply?: (value: RfCurve) => void;
};

function CurveField({ name, label, value, required, autosave, title, scope, unit, range, inherited, onCurveApply, kindInput, onRfValueChange }: CurveFieldProps & {
  name: string; label: string; value?: EmpiricalValue; required?: boolean; autosave?: boolean;
}) {
  const [applied, setApplied] = useState(value);
  const curve = applied?.kind === 'rfCurve' ? applied : undefined;
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const source = applied ?? inherited;
  function update(next?: RfCurve) {
    if (onCurveApply && JSON.stringify(value) === JSON.stringify(next)) { setOpen(false); return; }
    const form = input.current?.form;
    flushSync(() => { setApplied(next); onRfValueChange?.(next); setOpen(false); });
    if (!form) return;
    if (autosave) form.requestSubmit();
    else if (onCurveApply && next) onCurveApply(readEmpirical(new FormData(form), name, 'rfCurve')!);
  }
  return <div className="v1-curve-field">
    {kindInput && <input type="hidden" name={kindInput} value={applied?.kind ?? 'rfCurve'} />}
    <input ref={input} type="hidden" name={name} value={formatValue(kindInput ? applied : curve)} />
    <span>{label}</span>
    {curve && <details><summary>{curve.points.length} 个折点</summary><pre>{formatValue(curve)}</pre></details>}
    <button type="button" onClick={() => setOpen(true)}>编辑曲线</button>
    {curve && !required && <button type="button" data-skip-autosave onClick={() => update()}>清空曲线</button>}
    {open && <RfCurveEditor title={title} scope={scope} unit={unit} range={range}
      source={source?.kind === 'rfCurve' ? source.points : undefined} fixed={source?.kind === 'fixed' ? source.value : undefined}
      close={() => setOpen(false)} apply={points => update({ kind: 'rfCurve', points })} />}
  </div>;
}

function EmpiricalField({ kind, name, label, value, required, autosave, ...curveProps }: CurveFieldProps & {
  kind: ValueKind; name: string; label: string; value?: EmpiricalValue; required?: boolean; autosave?: boolean;
}) {
  if (kind === 'channelTable') return <ChannelTableField name={name} label={label}
    values={value?.kind === 'channelTable' ? value.values : undefined} required={required} autosave={autosave} />;
  if (kind === 'rfCurve') return <CurveField {...curveProps} name={name} label={label} value={value} required={required} autosave={autosave} />;
  const initial = value?.kind === 'fixed' ? formatValue(value) : '';
  return <label>{label}
    <input name={name} type="number" step="any" defaultValue={initial} required={required}
      onChange={event => curveProps.onRfValueChange?.(event.target.value === '' ? undefined : { kind: 'fixed', value: event.target.valueAsNumber })} />
  </label>;
}

function ChannelTableField({ name, label, values, required, autosave }: {
  name: string; label: string; values?: Partial<Record<OpticalChannelId, number>>; required?: boolean; autosave?: boolean;
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
        {(!required || rows.length > 1) && <button type="button" onClick={event => {
          const remove = () => setRows(previous => previous.filter(item => item.key !== row.key));
          if (autosave) {
            const form = event.currentTarget.form;
            flushSync(remove);
            form?.requestSubmit();
          } else {
            remove();
          }
        }}>移除此行</button>}
      </div>
    </div>)}
    <button type="button" onClick={() => setRows([...rows, { key: crypto.randomUUID(), channel: undefined, amount: undefined }])}>添加通道行</button>
  </fieldset>;
}

export function ParameterField({ parameter, value, inherited, label, autosave }: { parameter: ParameterDefinition; value?: ParameterValue; inherited?: ParameterValue; label: string; autosave?: boolean }) {
  if (parameter.kind === 'enum') {
    return <label>{label}<select name="value" defaultValue={typeof value === 'string' ? value : ''}>
      <option value="">未设置</option>
      {parameter.options.map(option => <option key={option} value={option}>{enumLabel(option)}</option>)}
    </select></label>;
  }
  return <NumericField parameter={parameter} value={typeof value === 'string' ? undefined : value}
    inherited={typeof inherited === 'string' ? undefined : inherited} label={label} autosave={autosave} />;
}

function NumericField({ parameter, value, inherited, label, autosave }: {
  parameter: NumericParameter; value?: EmpiricalValue; inherited?: EmpiricalValue; label: string; autosave?: boolean;
}) {
  const kinds = parameterValueKinds(parameter);
  const [kind, setKind] = useState(value?.kind ?? kinds[0]);
  const [rfValue, setRfValue] = useState(value);
  const supportsCurve = kinds.includes('rfCurve');
  return <>
    {kinds.length > 1 && <label>取值方式<select value={kind} onChange={event => setKind(event.target.value as ValueKind)}>
      {kinds.map(item => <option key={item} value={item}>{modeNames[item]}</option>)}
    </select></label>}
    {kind !== 'rfCurve' && <input type="hidden" name="valueKind" value={kind} />}
    {kind === 'fixed' && rfValue?.kind === 'rfCurve' && <input type="hidden" name="valueSavedCurve" value={formatValue(rfValue)} />}
    <EmpiricalField key={kind} name="value" kind={kind} label={`${label} (${parameter.unit})`}
      title={parameter.name} unit={parameter.unit} range={parameter.range} scope={label} kindInput="valueKind"
      value={supportsCurve ? rfValue : value} onRfValueChange={supportsCurve ? setRfValue : undefined} inherited={inherited} autosave={autosave} />
  </>;
}

type Quantity<K extends ValueKind> = Extract<EmpiricalValue, { kind: K }> | { kind: 'parameter'; parameterId: string };

export function readQuantity<K extends ValueKind>(data: FormData, name: string, kinds: readonly K[]): Quantity<K> | undefined {
  const kind = textField(data, name + 'Kind');
  if (kind === 'parameter') return { kind, parameterId: choice(data, name) };
  const selected = kinds.find(item => item === kind);
  if (selected === 'rfCurve' && !textField(data, name)) throw new Error('请编辑射频曲线，或选择「未设置」。');
  return selected && readEmpirical(data, name, selected);
}

export const rfKinds = ['fixed', 'rfCurve'] as const;
export const opticalKinds = ['fixed', 'channelTable'] as const;
const modeNames = { fixed: '固定值', rfCurve: '射频曲线折点', channelTable: '通道表', parameter: '引用参数' };

export function QuantityField({ name, label, kinds, value, parameters, minimum, hidden, unit = 'dB', onCurveApply }: {
  name: string; label: string; kinds: readonly ValueKind[];
  value?: EmpiricalValue | { kind: 'parameter'; parameterId: string }; parameters: readonly ParameterDefinition[];
  minimum?: number; hidden?: boolean; unit?: NumericUnit;
  onCurveApply?: (value: RfCurve) => void;
}) {
  const [kind, setKind] = useState<ValueKind | 'parameter' | ''>(value?.kind ?? '');
  const options = parameters.filter(parameter =>
    parameter.kind === 'numeric' && parameter.unit === unit && parameterValueKinds(parameter).every(item => kinds.includes(item))
    && (minimum === undefined || (parameter.range?.min ?? -Infinity) >= minimum));
  return <fieldset hidden={hidden} disabled={hidden}>
    <legend>{label}</legend>
    <label>取值方式<select name={name + 'Kind'} value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
      <option value="">未设置</option>
      {kinds.map(item => <option key={item} value={item}>{modeNames[item]}</option>)}
      {options.length > 0 && <option value="parameter">{modeNames.parameter}</option>}
    </select></label>
    {kind === 'parameter' ? <label>参数<select name={name} defaultValue={value?.kind === 'parameter' ? value.parameterId : ''} required>
      <option value="">请选择</option>
      {options.map(parameter => <option key={parameter.id} value={parameter.id}>{parameter.name}</option>)}
    </select></label> : kind && <EmpiricalField key={kind} kind={kind} name={name} label={`数值 (${unit})`} required
      title={label} unit={unit} range={{ min: minimum }} scope={onCurveApply ? '当前定义 · 传输参数' : '器件库模板 · 传输参数'} onCurveApply={onCurveApply}
      value={value?.kind === 'parameter' ? undefined : value} />}
  </fieldset>;
}
