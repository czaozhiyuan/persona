import { useState } from 'react';
import type { LocalEndpointRef } from '../../../model/v1/topology';
import type { InstancePath, ModuleDefinition } from '../../../model/v1/types';
import { connectBoundaryPort } from '../../../state/v1/module-ports';
import type { ProjectStore } from '../../../state/v1/project-store';
import { portDisplayName } from '../../../workbench/v1/labels';

export type BindingPreview = { scope: InstancePath; module: ModuleDefinition; portId: string; target?: LocalEndpointRef };

export function PortBindingDialog({ store, preview, locations, close }: {
  store: ProjectStore; preview: BindingPreview; locations: readonly string[]; close: () => void;
}) {
  const { scope, module, portId, target } = preview;
  const [base] = useState(() => store.getSnapshot().project);
  const [error, setError] = useState('');
  const port = module.ports.find(port => port.id === portId)!;
  const previous = module.portMappings?.find(mapping => mapping.portId === portId)!;
  function endpointLabel(ref: LocalEndpointRef) {
    const child = store.resolveInstance([...scope, ref.instanceId]);
    const port = child?.definition.ports.find(item => item.id === ref.portId);
    return `${child?.instance?.name ?? '未找到的对象'} · ${port ? portDisplayName(port, true, child?.definition.ports, child) : '未找到的端口'}`;
  }
  function confirm() {
    if (base !== store.getSnapshot().project) {
      setError('当前工程已变化，请重新预览。');
      return;
    }
    const result = store.commit(draft => connectBoundaryPort(draft, module.id, portId, target));
    if (result.ok) close();
    else setError(result.message);
  }
  const occurrence = store.resolveInstance(scope);
  const moduleName = occurrence?.instance?.name ?? module.name;
  return <dialog ref={dialog => { if (dialog && !dialog.open) dialog.showModal(); }}
    className="v1-topology-dialog" aria-labelledby="port-binding-title" onCancel={close}>
    <h3 id="port-binding-title">{target ? '更换内部连接' : '解除内部连接'}</h3>
    <p>{moduleName} · {portDisplayName(port, true, module.ports, occurrence)} 将断开与「{endpointLabel(previous.target)}」的连接。</p>
    {target && <p>随后连接到「{endpointLabel(target)}」。</p>}
    <p>对外端口及上层连线保留。{!target && '该端口将处于开放状态。'}</p>
    {locations.length > 0 && <p>编辑共享结构会同时应用到 {locations.join('、')}。</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="actions">
      <button type="button" autoFocus onClick={close}>取消</button>
      <button type="button" onClick={confirm}>{target ? '确认更换' : '确认解除'}</button>
    </div>
  </dialog>;
}
