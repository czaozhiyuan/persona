import { useState } from 'react';
import { PortDeletionDialog } from '../../editors/topology/v1/port-deletion-dialog';
import { resolveHierarchy } from '../../engine/v1/hierarchy';
import { builtInDefinitions } from '../../library/v1/built-in';
import { addTemplateInstance, previewTemplateUpdate } from '../../library/v1/project-snapshots';
import type { TemplateChanges } from '../../library/v1/project-snapshots';
import type { ModuleDefinition, Project } from '../../model/v1/types';
import type { ProjectStore, ProjectStoreSnapshot } from '../../state/v1/project-store';
import './library-panel.css';

type Props = { store: ProjectStore; state: ProjectStoreSnapshot; module: ModuleDefinition };
type Preview = {
  base: Project;
  result: ReturnType<typeof previewTemplateUpdate>;
  paths: readonly string[];
};

function describe(changes: TemplateChanges) {
  return [
    changes.added.length ? `已复制 ${changes.added.map(item => item.name).join('、')}` : '',
    changes.reused.length ? `沿用工程内的 ${changes.reused.map(item => item.name).join('、')}` : '',
  ].filter(Boolean).join('。');
}

function matchingTemplates(query: string) {
  const search = query.trim().toLowerCase();
  return builtInDefinitions.filter(item => item.name.toLowerCase().includes(search));
}

export function LibraryPanel({ store, state, module }: Props) {
  const { project, selection } = state;
  const [query, setQuery] = useState('');
  const [templateId, setTemplateId] = useState<string>(builtInDefinitions[0].id);
  const [preview, setPreview] = useState<Preview>();
  const [unlink, setUnlink] = useState<string>();
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean; snapshot?: Project }>();
  const template = builtInDefinitions.find(item => item.id === templateId)!;
  const existing = [...project.componentDefinitions, ...project.moduleDefinitions].find(item => item.id === templateId);
  const activePreview = preview?.base === project ? preview : undefined;
  const compatible = activePreview?.result.ok ? activePreview.result : undefined;
  const hasChanges = !!(compatible?.definitionChanges.length || compatible?.changes.added.length);

  function prepareUpdate() {
    if (!existing) return;
    const result = previewTemplateUpdate(project, builtInDefinitions, templateId);
    const paths: string[] = [];
    for (const occurrence of resolveHierarchy(project).walkInstances()) {
      if (occurrence.definition.id === templateId) paths.push(JSON.stringify(occurrence.instancePath));
    }
    setPreview({ base: project, result, paths });
    setFeedback(undefined);
  }

  function applyUpdate() {
    if (!activePreview?.result.ok || !hasChanges || store.getSnapshot().project !== activePreview.base) return;
    const { project: candidate, changes } = activePreview.result;
    const result = store.commit(() => candidate);
    if (result.ok) setPreview(undefined);
    setFeedback(result.ok ? { text: `已更新工程定义 ${templateId}。${describe(changes)}`, snapshot: store.getSnapshot().project }
      : { text: result.message, error: true });
  }

  function selectTemplate(id: string) {
    setTemplateId(id);
    setPreview(undefined);
    setFeedback(undefined);
  }

  const matches = matchingTemplates(query);
  return <section className="panel v1-properties" aria-label="离线器件与模块库">
    <label>搜索器件库<input type="search" value={query} onChange={event => {
      const next = event.target.value;
      const results = matchingTemplates(next);
      setQuery(next);
      if (results[0] && !results.some(item => item.id === templateId)) selectTemplate(results[0].id);
    }} /></label>
    {matches.length > 0 ? <>
    <label>器件或模块<select value={templateId} onChange={event => selectTemplate(event.target.value)}>
      {matches.map(item => <option key={item.id} value={item.id}>{item.name} · {item.kind === 'module' ? '模块' : '器件'}</option>)}
    </select></label>
    <p className="v1-property-effective">
      {existing ? (existing.kind === template.kind ? `添加时沿用工程中的「${existing.name}」`
        : '该模板与工程内已有的类型冲突。')
        : `添加位置 · ${store.resolveInstance(selection.modulePath)?.instance?.name ?? module.name}`}
    </p>
    <form key={templateId} onSubmit={event => {
      event.preventDefault();
      const name = String(new FormData(event.currentTarget).get('instanceName') ?? '').trim();
      if (!name) { setFeedback({ error: true, text: '名称不能为空。' }); return; }
      const id = crypto.randomUUID();
      let changes: TemplateChanges | undefined;
      const result = store.commit(draft => {
        const plan = addTemplateInstance(draft, builtInDefinitions, templateId, module.id, id, name);
        changes = plan.changes;
        return plan.project;
      });
      if (result.ok) store.selectInstance([...selection.modulePath, id]);
      setPreview(undefined);
      setFeedback(result.ok ? { text: `已添加「${name}」。${changes ? describe(changes) : ''}`, snapshot: store.getSnapshot().project }
        : { error: true, text: result.message });
    }}>
      <label>名称<input name="instanceName" defaultValue={template.name} required /></label>
      <button type="submit" disabled={!!existing && existing.kind !== template.kind}>添加到当前模块</button>
    </form>
    {existing && <details><summary>高级库设置</summary><button type="button" onClick={prepareUpdate}>预检从库更新</button></details>}
    {feedback && (!feedback.snapshot || feedback.snapshot === project) &&
      <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'error' : 'v1-property-effective'}>{feedback.text}</p>}
    {preview && !activePreview && <p role="status">工程已变化，请重新预检。</p>}
    {activePreview && <div className="v1-property-effective" aria-label="模板更新预检">
      <h3>{activePreview.result.ok ? '预检通过' : '无法更新工程定义'}</h3>
      <p>更新目标 {templateId}。已存在的依赖定义沿用工程快照。</p>
      {activePreview.paths.length > 0 && <details><summary>受影响实例路径（{activePreview.paths.length}）</summary>
        <ul>{activePreview.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul>
      </details>}
      {compatible && <>
        {compatible.changes.added.length > 0 && <p>将复制依赖：{compatible.changes.added.map(item => item.name).join('、')}</p>}
        {compatible.definitionChanges.length > 0 && <details open className="v1-library-diff">
          <summary>将应用的定义变更（{compatible.definitionChanges.length} 项）</summary>
          <ul>{compatible.definitionChanges.map(change => (
            <li key={JSON.stringify([change.field, change.id])}>
              <strong>{change.before === undefined ? '新增' : change.after === undefined ? '移除' : '修改'}{change.field}</strong>
              {change.id && <> · <code>{change.id}</code></>}
              <div className="v1-library-diff-values">
                <div>当前工程<pre>{change.before === undefined ? '无' : JSON.stringify(change.before, null, 2)}</pre></div>
                <div>更新后<pre>{change.after === undefined ? '无' : JSON.stringify(change.after, null, 2)}</pre></div>
              </div>
            </li>
          ))}</ul>
        </details>}
        {!hasChanges && <p>工程定义已与此次更新的内容一致。</p>}
      </>}
      {!activePreview.result.ok && activePreview.result.removedPorts.length > 0 &&
        <p>模板移除端口：{activePreview.result.removedPorts.join('、')}</p>}
      {!activePreview.result.ok && <p className="error" role="alert">{activePreview.result.message}</p>}
      <div className="actions">
        <button type="button" onClick={() => setPreview(undefined)}>取消更新</button>
        {activePreview.result.ok ? (hasChanges && <button type="button" onClick={applyUpdate}>确认应用上述变更</button>)
          : activePreview.result.removedPorts.map(port => <button type="button" key={port}
            onClick={() => setUnlink(port)}>预览解绑 {port}</button>)}
      </div>
    </div>}
    {unlink !== undefined && <PortDeletionDialog store={store} definitionId={templateId} portId={unlink}
      close={() => {
        setUnlink(undefined);
        if (store.getSnapshot().project !== preview?.base) setPreview(undefined);
      }} />}
    </> : <p className="empty" role="status">没有匹配的器件或模块。</p>}
  </section>;
}
