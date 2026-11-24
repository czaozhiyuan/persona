import { readParameters } from '../../engine/v1/hierarchy';
import { useState } from 'react';
import type { ComponentDefinition } from '../../model/v1/types';
import { portDisplayName } from './labels';
import { CapacityField, readCapacity } from './properties/dc-fields';
import { QuantityField, readQuantity } from './properties/value-fields';

export function TemplatePower({ definition }: { definition: ComponentDefinition }) {
  const [supply, setSupply] = useState(definition.dcSupply?.portId ?? '');
  const [load, setLoad] = useState(definition.dcLoad?.portId ?? '');
  const parameters = definition.parameters ?? [];
  const effective = readParameters(definition);
  return <details><summary>直流电源与负载</summary><form data-power onSubmit={e => e.preventDefault()}>
    <label>供电输出<select name="supply" value={supply} onChange={e => setSupply(e.target.value)}><option value="">未设置</option>
      {definition.ports.filter(p => p.type === 'DC_POWER' && p.direction === 'out').map(p =>
        <option key={p.id} value={p.id}>{portDisplayName(p, false, definition.ports, effective)}</option>)}</select></label>
    {supply && <CapacityField capacity={definition.dcSupply?.capacity} parameters={parameters} />}
    <label>负载输入<select name="load" value={load} onChange={e => setLoad(e.target.value)}><option value="">未设置</option>
      {definition.ports.filter(p => p.type === 'DC_POWER' && p.direction === 'in').map(p =>
        <option key={p.id} value={p.id}>{portDisplayName(p, false, definition.ports, effective)}</option>)}</select></label>
    {load && <QuantityField name="power" label="负载功耗" unit="W" kinds={['fixed']} minimum={0}
      parameters={parameters} value={definition.dcLoad?.powerW} />}
  </form></details>;
}

export function readPower(data: FormData): Pick<ComponentDefinition, 'dcSupply' | 'dcLoad'> {
  const supply = String(data.get('supply') ?? '');
  const load = String(data.get('load') ?? '');
  return { dcSupply: supply ? { portId: supply, capacity: readCapacity(data) } : undefined,
    dcLoad: load ? { portId: load, powerW: readQuantity(data, 'power', ['fixed']) } : undefined };
}
