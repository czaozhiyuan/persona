import { createPathNames } from '../../../workbench/v1/structure-scope';
import { resolveHierarchy } from '../../../engine/v1/hierarchy';
import { useState } from 'react';
import type { ProjectStore } from '../../../state/v1/project-store';
import { planPortDeletion } from '../../../state/v1/topology-edits';
import './topology.css';

export function PortDeletionDialog({ store, definitionId, portId, close, onDeleted }: {
  store: ProjectStore; definitionId: string; portId: string; close: () => void; onDeleted?: () => void;
}) {
  const [{ base, plan }] = useState(() => {
    const base = store.getSnapshot().project;
    return { base, plan: planPortDeletion(base, definitionId, portId) };
  });
  const { showPath } = createPathNames([...resolveHierarchy(base).walkInstances()]);
  const definitions = new Map([...base.moduleDefinitions, ...base.componentDefinitions].map(d => [d.id, d.name]));
  const [error, setError] = useState('');
  function confirm() {
    if (store.getSnapshot().project !== base || !plan) {
      setError('当前工程已变化，请重新预览。');
      return;
    }
    const result = store.commit(() => plan.project);
    if (result.ok) {
      onDeleted?.();
      close();
    }
    else setError(result.message);
  }
  return <dialog ref={dialog => { if (dialog && !dialog.open) dialog.showModal(); }}
    className="v1-topology-dialog" aria-labelledby="port-deletion-title" onCancel={close}>
    <h3 id="port-deletion-title">删除端口的影响</h3>
    {plan ? <ul>{plan.impacts.map((impact, index) => <li key={index}>
      <strong>{impact.kind === '端口映射' ? '内部连接' : impact.kind}</strong> · {impact.name} · 定义 {definitions.get(impact.definitionId) ?? '未找到的定义'}
      {impact.paths.length > 0 && <ul>{impact.paths.map(path =>
        <li key={JSON.stringify(path)}><code>{showPath(path)}</code></li>)}</ul>}
    </li>)}</ul> : <p>端口已不存在。</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="actions">
      <button type="button" autoFocus onClick={close}>取消</button>
      <button type="button" disabled={!plan} onClick={confirm}>确认删除并解绑</button>
    </div>
  </dialog>;
}
