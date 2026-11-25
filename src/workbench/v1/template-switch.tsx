import { supportsDirection } from '../../model/v1/types';
import { useState } from 'react';
import type { OpticalRoute, SwitchState } from '../../model/v1/device';
import type { ComponentDefinition } from '../../model/v1/types';
import { readTransfer, TransferFields } from './properties/device-fields';

const row = (route: OpticalRoute) => ({ key: crypto.randomUUID(), route });

export function TemplateSwitch({ definition }: { definition: ComponentDefinition }) {
  const [states, edit] = useState(() => (definition.switchStates ?? []).map(s => ({ ...s, routes: s.routes.map(row) })));
  return <details><summary>光开关状态与路由</summary>
    {states.map(s => <fieldset key={s.id} data-switch-state={s.id}><legend>{s.name}</legend>
      <label>状态名称<input name="stateName" value={s.name} required onChange={e =>
        edit(states.map(other => other.id === s.id ? { ...s, name: e.target.value } : other))} /></label>
      {s.routes.map(r => <div key={r.key}>
        <TransferFields draft definition={definition} transfer={{ ...r.route, kind: 'optical' }} save={() => {}} />
        <button onClick={() => edit(states.map(other => other.id === s.id ? { ...s, routes: s.routes.filter(item => item.key !== r.key) } : other))}>移除光路</button>
      </div>)}
      <button onClick={() => edit(states.map(other => other.id === s.id ? { ...s, routes: [...s.routes, row({
        fromPortId: definition.ports.find(p => p.type === 'OPTICAL' && supportsDirection(p.direction, 'in'))?.id ?? '',
        toPortId: definition.ports.find(p => p.type === 'OPTICAL' && supportsDirection(p.direction, 'out'))?.id ?? '',
      })] } : other))}>添加光路</button>
      <button onClick={() => edit(states.filter(other => other.id !== s.id))}>删除状态</button>
    </fieldset>)}
    <button onClick={() => edit([...states, { id: crypto.randomUUID(), name: '新状态', routes: [] }])}>添加开关状态</button>
  </details>;
}

export function readSwitchStates(root: HTMLElement): SwitchState[] | undefined {
  const states = Array.from(root.querySelectorAll<HTMLElement>('[data-switch-state]'), fieldset => {
    const name = fieldset.querySelector<HTMLInputElement>('[name=stateName]')!.value.trim();
    if (!name) throw new Error('请填写开关状态名称。');
    const routes = Array.from(fieldset.querySelectorAll('form'), form => {
      if (!form.reportValidity()) throw new Error('请检查开关光路字段。');
      const transfer = readTransfer(new FormData(form), { kind: 'optical', fromPortId: '', toPortId: '' });
      if (transfer.kind !== 'optical') throw new Error('请选择光传输路由。');
      const { kind, ...route } = transfer;
      return route;
    });
    return { id: fieldset.dataset.switchState!, name, routes };
  });
  return states.length ? states : undefined;
}
