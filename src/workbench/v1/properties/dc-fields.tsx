import { useState } from 'react';
import type { DcCapacity } from '../../../model/v1/device';
import type { ParameterDefinition } from '../../../model/v1/parameters';
import { QuantityField, readQuantity } from './value-fields';

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
