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
      <label>类型<select name="type">
        {Object.entries(portTypeLabels).map(([type, label]) => <option value={type} key={type}>{type} · {label}</option>)}
      </select></label>
      <label>方向<select name="direction"><option value="in">输入</option><option value="out">输出</option></select></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button type="submit">添加端口</button>
        <button type="button" onClick={close}>取消</button>
      </div>
    </form>
  </dialog>;
}
