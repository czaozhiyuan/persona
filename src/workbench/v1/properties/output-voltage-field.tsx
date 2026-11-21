import type { DcValue } from '../../../model/v1/device';
import { choice, numberField } from './value-fields';

export function readOutputVoltage(data: FormData): DcValue | undefined {
  const parameterId = choice(data, 'outputVoltageParameter');
  if (parameterId) return { kind: 'parameter', parameterId };
  const value = numberField(data, 'outputVoltageV');
  return value === undefined ? undefined : { kind: 'fixed', value };
}

export function OutputVoltageField({ value }: { value?: number }) {
  return <label>输出电压 (V)<input name="outputVoltageV" type="number" min={Number.MIN_VALUE} step="any"
    placeholder="未设置" defaultValue={value} /></label>;
}
