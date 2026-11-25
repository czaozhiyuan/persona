import { readParameters } from '../../engine/v1/hierarchy';
import { useState } from 'react';
import type { ComponentDefinition } from '../../model/v1/types';
import { portDisplayName } from './labels';
import { QuantityField, readQuantity } from './properties/value-fields';

export function TemplatePower({ definition, setSupply }: { definition: ComponentDefinition; setSupply: (enabled: boolean) => void }) {
  const [load, setLoad] = useState(definition.dcLoad?.portId ?? '');
  const parameters = definition.parameters ?? [];
  const effective = { parameters: readParameters(definition) };
  return <details><summary>直流电源与负载</summary><form data-power onSubmit={e => e.preventDefault()}>
    <label><input type="checkbox" checked={!!definition.dcSupply} onChange={e => setSupply(e.target.checked)} />
      直流电源（每个直流输出端口独立供电）</label>
    <label>负载输入<select name="load" value={load} onChange={e => setLoad(e.target.value)}><option value="">未设置</option>
      {definition.ports.filter(p => p.type === 'DC_POWER' && p.direction === 'in').map(p =>
        <option key={p.id} value={p.id}>{portDisplayName(p, false, definition.ports, effective)}</option>)}</select></label>
    {load && <QuantityField name="power" label="负载功耗" unit="W" kinds={['fixed']} minimum={0}
      parameters={parameters} value={definition.dcLoad?.powerW} />}
  </form></details>;
}

export function readPower(data: FormData): Pick<ComponentDefinition, 'dcLoad'> {
  const load = String(data.get('load') ?? '');
  return { dcLoad: load ? { portId: load, powerW: readQuantity(data, 'power', ['fixed']) } : undefined };
}
