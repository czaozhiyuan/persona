import { useState } from 'react';
import type { ComponentDefinition } from '../../../model/v1/types';
import { portDisplayName } from '../labels';
import { QuantityField, readQuantity } from './value-fields';

export function DcLoadFields({ definition, parameters, save }: {
  parameters: import('../../../model/v1/display-names').PortLabelContext['parameters'];
  definition: ComponentDefinition; save: (read: () => ComponentDefinition['dcLoad']) => void;
}) {
  const ports = definition.ports.filter(port => port.type === 'DC_POWER' && port.direction === 'in');
  const [portId, setPortId] = useState(definition.dcLoad?.portId ?? '');
  if (!ports.length) return null;
  return <details><summary>直流负载</summary><form onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    save(() => portId ? { portId, powerW: readQuantity(data, 'loadPower', ['fixed']) } : undefined);
  }}>
    <label>负载输入<select value={portId} onChange={event => setPortId(event.target.value)}>
      <option value="">未设置</option>
      {ports.map(port => <option key={port.id} value={port.id}>{portDisplayName(port, true, definition.ports, { parameters })}</option>)}
    </select></label>
    {portId && <QuantityField name="loadPower" label="负载功耗" unit="W" kinds={['fixed']} minimum={0}
      parameters={definition.parameters ?? []} value={definition.dcLoad?.powerW} />}
    <button type="submit">保存直流负载</button>
  </form></details>;
}
