import { useState } from 'react';
import type { PortDefinition, PortDirection, PortType } from '../../../model/v1/types';
import { portTypeLabels } from '../labels';

export function AddPortDialog({ name, locations, add, close }: {
  name: string;
  locations: readonly string[];
  add: (port: PortDefinition) => string | undefined;
  close: () => void;
}) {
  const [error, setError] = useState('');
  return <dialog ref={dialog => { if (dialog && !dialog.open) dialog.showModal(); }}
    className="v1-topology-dialog v1-add-port-dialog" aria-labelledby="add-port-title" onCancel={close}>
    <h3 id="add-port-title">添加端口 · {name}</h3>
    {locations.length > 0 && <p>端口属于共享定义，以下实例将同时新增端口：{locations.join('、')}。</p>}
    <form onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const result = add({ id: crypto.randomUUID(), name: String(data.get('name')),
        type: data.get('type') as PortType, direction: data.get('direction') as PortDirection });
      if (result) setError(result);
      else close();
    }}>
      <label>端口名称<input name="name" required autoFocus /></label>
      <div className="v1-port-choices">
        <fieldset>
          <legend>类型</legend>
          {Object.entries(portTypeLabels).map(([type, label]) => <label key={type}>
            <input type="radio" name="type" value={type} defaultChecked={type === 'RF'} />{type} · {label}
          </label>)}
        </fieldset>
        <fieldset>
          <legend>方向</legend>
          <label><input type="radio" name="direction" value="in" defaultChecked />输入</label>
          <label><input type="radio" name="direction" value="out" />输出</label>
        </fieldset>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button type="submit">添加端口</button>
        <button type="button" onClick={close}>取消</button>
      </div>
    </form>
  </dialog>;
}
