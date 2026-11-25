import { useState } from 'react';
import type { DcCapacity, SupplyCapacity } from '../../../model/v1/device';
import type { ParameterDefinition } from '../../../model/v1/parameters';
import { numberField, QuantityField, readQuantity } from './value-fields';

export function SupplyCapacityField({ value }: { value?: SupplyCapacity }) {
  return <fieldset>
    <legend>该路额定输出容量（可选）</legend>
    <label>单位<select name="supplyUnit" defaultValue={value?.unit ?? 'W'}><option>W</option><option>A</option></select></label>
    <label>额定值<input name="supplyCapacity" type="number" min={0} step="any" defaultValue={value?.value.value} placeholder="未设置" /></label>
  </fieldset>;
}

export function readSupplyCapacity(data: FormData): SupplyCapacity | undefined {
  const value = numberField(data, 'supplyCapacity');
  return value === undefined ? undefined : { unit: data.get('supplyUnit') === 'A' ? 'A' : 'W', value: { kind: 'fixed', value } };
}

export function CapacityField({ capacity, parameters }: { capacity?: DcCapacity; parameters: readonly ParameterDefinition[] }) {
  const [unit, setUnit] = useState(capacity?.unit ?? 'W');
  return <>
    <label>容量单位<select name="capacityUnit" value={unit} onChange={e => setUnit(e.target.value as DcCapacity['unit'])}>
      <option>W</option><option>A</option></select></label>
    <QuantityField key={unit} name="capacity" label="额定输出容量" kinds={['fixed']} unit={unit} minimum={0}
      parameters={parameters} value={capacity?.unit === unit ? capacity.value : undefined} />
  </>;
}

export function readCapacity(data: FormData): DcCapacity | undefined {
  const value = readQuantity(data, 'capacity', ['fixed']);
  if (value) return { unit: data.get('capacityUnit') === 'A' ? 'A' : 'W', value };
}
