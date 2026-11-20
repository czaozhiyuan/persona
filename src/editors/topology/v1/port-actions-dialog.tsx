import { portDisplayName, portTypeLabels } from '../../../workbench/v1/labels';
import type { PortDefinition } from '../../../model/v1/types';
import { field } from './wiring-forms';

type PortActions = {
  port: PortDefinition;
  name: string;
  error?: string;
  rename: (name: string) => void;
  locations: readonly string[];
  exposure?: { moduleName: string; locations: readonly string[]; create: (name: string) => void };
  disconnect?: () => void;
  close: () => void;
};

export function PortActionsDialog({ port, name, rename, locations, exposure, disconnect, close, error }: PortActions) {
  return <dialog ref={dialog => { if (dialog && !dialog.open) dialog.showModal(); }}
    className="v1-topology-dialog v1-port-actions" aria-labelledby="port-actions-title" onCancel={close}>
    <h3 id="port-actions-title">{name} · {portDisplayName(port)}</h3>
    <p>{portTypeLabels[port.type]} · {port.direction === 'in' ? '输入' : '输出'}</p>
    {exposure && <form onSubmit={event => {
      event.preventDefault();
      exposure.create(field(new FormData(event.currentTarget), 'name'));
    }}>
      <p>在「{exposure.moduleName}」边界创建对外端口，并连接到此端口。</p>
      {exposure.locations.length > 0 && <p>编辑共享结构会同时应用到 {exposure.locations.join('、')}。</p>}
      <label>对外端口名称 <input name="name" defaultValue={portDisplayName(port)} required autoFocus /></label>
      <button type="submit">引出为当前模块端口</button>
    </form>}
    <form onSubmit={event => {
      event.preventDefault();
      rename(field(new FormData(event.currentTarget), 'name'));
    }}>
      {locations.length > 0 && <p>显示名称会更新到 {locations.join('、')}。</p>}
      <label>显示名称 <input name="name" defaultValue={port.name} placeholder={port.id} autoFocus={!exposure} /></label>
      <button type="submit">保存显示名称</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="actions">
      {disconnect && <button type="button" onClick={disconnect}>解除内部连接</button>}
      <button type="button" onClick={close}>关闭</button>
    </div>
  </dialog>;
}
