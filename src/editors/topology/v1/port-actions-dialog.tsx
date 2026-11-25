import { portDirectionLabels } from '../../../model/v1/types';
import { editablePortName, portDisplayName, portTypeLabels } from '../../../workbench/v1/labels';
import { isPowerPort } from '../../../model/v1/types';
import type { PortDefinition } from '../../../model/v1/types';
import { field } from './wiring-forms';

type PortActions = {
  readings?: import('react').ReactNode;
  port: PortDefinition;
  name: string;
  label: string;
  error?: string;
  rename: (name: string) => void;
  locations: readonly string[];
  exposure?: { moduleName: string; locations: readonly string[]; create: (name: string) => void };
  disconnect?: () => void;
  close: () => void;
  canEditLink?: boolean;
  budget?: (action: 'optical' | 'from' | 'to', editCurrent?: boolean) => void;
};

export function PortActionsDialog({ port, name, label, rename, locations, exposure, disconnect, close, error, budget, readings, canEditLink }: PortActions) {
  return <dialog ref={dialog => { if (dialog && !dialog.open) dialog.showModal(); }}
    className="v1-topology-dialog v1-port-actions" aria-labelledby="port-actions-title" onCancel={close}>
    <h3 id="port-actions-title">{name} · {label}</h3>
    <p>{portTypeLabels[port.type]} · {portDirectionLabels[port.direction]}</p>
    {readings}
    {budget && !isPowerPort(port.type) && <div className="actions v1-port-budget-actions">
      {port.type === 'OPTICAL' && port.direction !== 'in' &&
        <button type="button" onClick={() => budget('optical')}>查看此处光功率</button>}
      <button type="button" onClick={() => budget('from')}>{canEditLink ? '设为新链路起点' : '设为链路起点'}</button>
      <button type="button" onClick={() => budget('to')}>{canEditLink ? '设为新链路终点' : '设为链路终点'}</button>
      {canEditLink && <>
        <button type="button" onClick={() => budget('from', true)}>修改当前链路起点</button>
        <button type="button" onClick={() => budget('to', true)}>修改当前链路终点</button>
      </>}
    </div>}
    {exposure && <form onSubmit={event => {
      event.preventDefault();
      exposure.create(field(new FormData(event.currentTarget), 'name'));
    }}>
      <p>在「{exposure.moduleName}」边界创建对外端口，并连接到此端口。</p>
      {exposure.locations.length > 0 && <p>编辑共享结构会同时应用到 {exposure.locations.join('、')}。</p>}
      {!isPowerPort(port.type) && <label>对外端口名称 <textarea rows={2} name="name" defaultValue={portDisplayName(port)} required autoFocus /></label>}
      <button type="submit">引出为当前模块端口</button>
    </form>}
    {!isPowerPort(port.type) && <form onSubmit={event => {
      event.preventDefault();
      rename(field(new FormData(event.currentTarget), 'name'));
    }}>
      {locations.length > 0 && <p>显示名称会更新到 {locations.join('、')}。</p>}
      <label>显示名称 <textarea rows={2} name="name" defaultValue={editablePortName(port)} placeholder={portDisplayName(port)} autoFocus={!exposure} /></label>
      <button type="submit">保存显示名称</button>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="actions">
      {disconnect && <button type="button" onClick={disconnect}>解除内部连接</button>}
      <button type="button" onClick={close}>关闭</button>
    </div>
  </dialog>;
}
