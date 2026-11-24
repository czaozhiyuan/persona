import type { ParameterDefinition } from '../../../model/v1/parameters';
import type { DcValue } from '../../../model/v1/device';
import type { PortDirection, PortType } from '../../../model/v1/types';
import { choice, numberField } from './value-fields';

export function voltageParameters(parameters: readonly ParameterDefinition[] = []) {
  return parameters.filter(p => p.kind === 'numeric' && p.unit === 'V' && p.valueKind === 'fixed' && (p.range?.min ?? 0) > 0);
}

export function readPortVoltage(data: FormData, direction: PortDirection): DcValue | undefined {
  const parameterId = choice(data, direction === 'in' ? 'inputVoltageParameter' : 'outputVoltageParameter');
  if (parameterId) return { kind: 'parameter', parameterId };
  const value = numberField(data, direction === 'in' ? 'inputVoltageV' : 'outputVoltageV');
  return value === undefined ? undefined : { kind: 'fixed', value };
}

export function voltageTitle(type: PortType, direction: PortDirection) {
  return `${direction === 'in' ? '标称输入电压' : '输出电压'} (${type === 'AC_POWER' ? 'V RMS' : 'V'})`;
}

export function PortVoltageField({ value, type, direction }: { value?: number; type: PortType; direction: PortDirection }) {
  return <label>{voltageTitle(type, direction)}<input name={direction === 'in' ? 'inputVoltageV' : 'outputVoltageV'} type="number" min={Number.MIN_VALUE} step="any"
    placeholder="未设置" defaultValue={value} /></label>;
}
