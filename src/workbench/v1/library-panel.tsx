import { useState } from 'react';
import { insertCanvasItem } from '../../editors/topology/v1/topology-layout-edits';
import { PortDeletionDialog } from '../../editors/topology/v1/port-deletion-dialog';
import { resolveHierarchy } from '../../engine/v1/hierarchy';
import { builtInDefinitions, isBlankTemplate } from '../../library/v1/built-in';
import { libraryDragType } from '../../library/v1/insert-library-item';
import type { LibraryItem } from '../../library/v1/insert-library-item';
import { previewTemplateUpdate } from '../../library/v1/project-snapshots';
import type { DragEvent } from 'react';
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
  const [projectId, setProjectId] = useState('');
  const [updateId, setUpdateId] = useState('');
  const [preview, setPreview] = useState<Preview>();
  const [unlink, setUnlink] = useState<string>();
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean; snapshot?: Project }>();
  const definitions = new Map([...project.componentDefinitions, ...project.moduleDefinitions].map(item => [item.id, item]));
  const installed = builtInDefinitions.filter(item => !isBlankTemplate(item.id) && definitions.has(item.id));
  const templateId = installed.find(item => item.id === updateId)?.id ?? installed[0]?.id ?? '';
  const activePreview = preview?.base === project ? preview : undefined;
  const compatible = activePreview?.result.ok ? activePreview.result : undefined;
  const hasChanges = !!(compatible?.definitionChanges.length || compatible?.changes.added.length);

  function prepareUpdate() {
    if (!templateId) return;
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
    setUpdateId(id);
    setPreview(undefined);
    setFeedback(undefined);
  }

  const unavailable = new Set([module.id]);
  for (const id of unavailable) {
    for (const candidate of project.moduleDefinitions) {
      if (candidate.instances.some(instance => instance.definitionId === id)) unavailable.add(candidate.id);
    }
  }
  const matches = matchingTemplates(query);
  const search = query.trim().toLowerCase();
  const reusable = project.moduleDefinitions.filter(candidate => !unavailable.has(candidate.id)
    && candidate.id !== project.rootModuleDefinitionId && candidate.name.toLowerCase().includes(search));
  const reusableModule = reusable.find(item => item.id === projectId) ?? reusable[0];

  function selectedItem(form: HTMLFormElement, source: LibraryItem['source'], id: string): LibraryItem {
    return { source, id, name: String(new FormData(form).get('instanceName') ?? '').trim() };
  }

  function add(item: LibraryItem) {
    if (!item.name) { setFeedback({ error: true, text: '名称不能为空。' }); return; }
    const id = crypto.randomUUID();
    const result = store.commit(draft => insertCanvasItem(draft, item, module.id, selection.modulePath, id));
    if (result.ok) store.selectInstance([...selection.modulePath, id]);
    setPreview(undefined);
    setFeedback(result.ok ? { text: `已添加「${item.name}」。`, snapshot: store.getSnapshot().project }
      : { error: true, text: result.message });
  }

  function drag(event: DragEvent<HTMLButtonElement>, item: LibraryItem) {
    if (!item.name) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(libraryDragType, JSON.stringify(item));
  }
  return <section className="panel v1-properties" aria-label="离线器件与模块库">
    <label>搜索器件库<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <p className="v1-property-effective">添加到 · {store.resolveInstance(selection.modulePath)?.instance?.name ?? module.name}</p>
    {matches.length > 0 && <ul className="v1-library-items" aria-label="可拖入框图的器件与模块">
      {matches.map(template => {
        const definition = isBlankTemplate(template.id) ? undefined : definitions.get(template.id);
        const conflict = !!definition && definition.kind !== template.kind;
        const item: LibraryItem = { source: 'template', id: template.id, name: template.name };
        return <li key={template.id}><button type="button" draggable={!conflict} disabled={conflict}
          title={conflict ? '该模板与工程内已有的类型冲突'
            : definition ? `点击或拖入框图，沿用工程定义「${definition.name}」` : '点击添加到当前模块，或拖入框图'}
          onClick={() => add(item)} onDragStart={event => drag(event, item)}>{template.name}</button></li>;
      })}
    </ul>}
    {!matches.length && !reusable.length && <p className="empty" role="status">没有匹配的器件或模块。</p>}
    {!!installed.length && <details><summary>高级库设置</summary>
      <label>工程内的模板<select value={templateId} onChange={event => selectTemplate(event.target.value)}>
        {installed.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <button type="button" onClick={prepareUpdate}>预检从库更新</button>
    </details>}
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
    {reusableModule && <details><summary>放入已有模块</summary>
      <label>工程模块<select value={reusableModule.id} onChange={event => setProjectId(event.target.value)}>
        {reusable.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <form key={reusableModule.id} onSubmit={event => {
        event.preventDefault();
        add(selectedItem(event.currentTarget, 'project', reusableModule.id));
      }}>
        <label>名称<input name="instanceName" defaultValue={reusableModule.name} required /></label>
        <button type="submit" draggable title="点击放入，或拖入框图" onDragStart={event => {
          const form = event.currentTarget.form;
          if (form) drag(event, selectedItem(form, 'project', reusableModule.id));
        }}>放入已有模块</button>
      </form>
    </details>}
    {feedback && (!feedback.snapshot || feedback.snapshot === project) &&
      <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'error' : 'v1-property-effective'}>{feedback.text}</p>}
  </section>;
}
