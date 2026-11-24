import { definitionLabels, numberedNamesById, portDisplayName, readableError } from '../../model/v1/display-names';
import { createPathNames } from './structure-scope';
import type { CenterPlacement } from '../../editors/topology/v1/topology-layout-edits';
import { useState } from 'react';
import { definitionIcon, DeviceIcon } from '../../editors/topology/v1/device-icon';
import { insertCanvasItem } from '../../editors/topology/v1/topology-layout-edits';
import { PortDeletionDialog } from '../../editors/topology/v1/port-deletion-dialog';
import { resolveHierarchy } from '../../engine/v1/hierarchy';
import { isBlankTemplate } from '../../library/v1/built-in';
import { libraryDragType } from '../../library/v1/insert-library-item';
import type { LibraryItem } from '../../library/v1/insert-library-item';
import { previewTemplateUpdate } from '../../library/v1/project-snapshots';
import type { DragEvent } from 'react';
import type { TemplateChanges } from '../../library/v1/project-snapshots';
import type { ModuleDefinition, Project } from '../../model/v1/types';
import type { ProjectStore, ProjectStoreSnapshot } from '../../state/v1/project-store';
import './library-panel.css';
import { libraryDefinitions } from '../../library/v1/user-library';
import type { LibraryConfig } from '../../library/v1/user-library';
import type { UserLibrary } from './use-library';
import { LibraryManager } from './library-manager';

type Props = { centerPlacement: CenterPlacement; library: UserLibrary; store: ProjectStore; state: ProjectStoreSnapshot; module: ModuleDefinition };
type Preview = {
  base: Project;
  library: LibraryConfig;
  result: ReturnType<typeof previewTemplateUpdate>;
  paths: readonly string[];
};

function describe(changes: TemplateChanges) {
  return [
    changes.added.length ? `已复制 ${changes.added.map(item => item.name).join('、')}` : '',
    changes.reused.length ? `沿用工程内的 ${changes.reused.map(item => item.name).join('、')}` : '',
  ].filter(Boolean).join('。');
}

export function LibraryPanel({ centerPlacement, library, store, state, module }: Props) {
  const [manage, setManage] = useState(false);
  const templates = libraryDefinitions(library.config);
  const labels = numberedNamesById(templates);
  const { project, selection } = state;
  const [query, setQuery] = useState('');
  const [definitionKey, setDefinitionKey] = useState('');
  const [updateId, setUpdateId] = useState('');
  const [preview, setPreview] = useState<Preview>();
  const [unlink, setUnlink] = useState<string>();
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean; snapshot?: Project }>();
  const definitions = new Map([...project.componentDefinitions, ...project.moduleDefinitions].map(item => [item.id, item]));
  const installed = templates.filter(item => !isBlankTemplate(item.id) && definitions.has(item.id));
  const templateId = installed.find(item => item.id === updateId)?.id ?? installed[0]?.id ?? '';
  const activePreview = preview?.base === project && preview.library === library.config ? preview : undefined;
  const compatible = activePreview?.result.ok ? activePreview.result : undefined;
  const hasChanges = !!(compatible?.definitionChanges.length || compatible?.changes.added.length);

  const target = definitions.get(templateId);
  const portName = (id: string) => {
    const port = target?.ports.find(p => p.id === id);
    return port ? portDisplayName(port, false, target?.ports) : '未找到的端口';
  };
  function prepareUpdate() {
    if (!templateId) return;
    const result = previewTemplateUpdate(project, templates, templateId);
    const paths: string[] = [];
    const occurrences = [...resolveHierarchy(project).walkInstances()];
    const { showPath } = createPathNames(occurrences);
    for (const occurrence of occurrences) {
      if (occurrence.definition.id === templateId) paths.push(showPath(occurrence.instancePath));
    }
    setPreview({ base: project, library: library.config, result, paths });
    setFeedback(undefined);
  }

  function applyUpdate() {
    if (!activePreview?.result.ok || !hasChanges || store.getSnapshot().project !== activePreview.base) return;
    const { project: candidate, changes } = activePreview.result;
    const result = store.commit(() => candidate);
    if (result.ok) setPreview(undefined);
    setFeedback(result.ok ? { text: `已更新工程定义 「${target?.name}」。${describe(changes)}`, snapshot: store.getSnapshot().project }
      : { text: result.message, error: true });
  }

  function changeValue(value: unknown, candidate: Project, field: string) {
    const definitions = new Map([...candidate.moduleDefinitions, ...candidate.componentDefinitions].map(d => [d.id, d]));
    const owner = definitions.get(templateId)!;
    const labels = definitionLabels(owner, candidate);
    function format(item: unknown, key: string, references = labels): unknown {
      if (typeof item === 'string') {
        if (key === '参数映射顺序' && owner.kind === 'module') {
          const mapping = owner.parameterMappings?.find(m => JSON.stringify([m.target.instanceId, m.target.parameterId]) === item);
          if (!mapping) return '未找到的参数映射';
          const child = owner.instances.find(i => i.id === mapping.target.instanceId);
          const parameter = child && definitions.get(child.definitionId)?.parameters?.find(p => p.id === mapping.target.parameterId);
          return (child?.name ?? '未找到的对象') + ' · ' + (parameter?.name ?? '未找到的参数');
        }
        if (key === 'definitionId') return definitions.get(item)?.name ?? '未找到的定义';
        if (key !== 'channelId' && (/Id$/.test(key) || key.endsWith('顺序'))) return references.get(item) ?? '未找到的引用对象';
        return readableError(item);
      }
      if (Array.isArray(item)) return item.map(v => format(v, key, references));
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const childId = record.definitionId ?? (owner.kind === 'module'
          ? owner.instances.find(child => child.id === record.instanceId)?.definitionId : undefined);
        const child = typeof childId === 'string' ? definitions.get(childId) : undefined;
        const childLabels = child ? definitionLabels(child, candidate) : references;
        return Object.fromEntries(Object.entries(record).map(([field, v]) => [
          key === 'parameterOverrides' ? references.get(field) ?? '未找到的参数' : field,
          field === 'id' ? references.get(String(v)) ?? '当前项' : format(v, field,
            ['portId', 'parameterId', 'parameterOverrides', 'switchStateId'].includes(field) ? childLabels : references),
        ]));
      }
      return item;
    }
    return value === undefined ? '无' : JSON.stringify(format(value, field), null, 2);
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
  const search = query.trim().toLowerCase();
  const matches = templates.filter(d => !library.config.hidden.includes(d.id) && labels.get(d.id)!.toLowerCase().includes(search));
  const reusable = [...definitions.values()].filter(candidate => !unavailable.has(candidate.id)
    && candidate.id !== project.rootModuleDefinitionId && candidate.name.toLowerCase().includes(search));
  const projectLabels = numberedNamesById(reusable);
  const namedOptions = [
    ...reusable.map(item => ({ key: 'project:' + item.id, item, source: 'project' as const })),
    ...matches.filter(item => isBlankTemplate(item.id) || !definitions.has(item.id))
      .map(item => ({ key: 'template:' + item.id, item, source: 'template' as const })),
  ];
  const namedOption = namedOptions.find(option => option.key === definitionKey) ?? namedOptions[0];

  function selectedItem(form: HTMLFormElement, source: LibraryItem['source'], id: string): LibraryItem {
    return { source, id, name: String(new FormData(form).get('instanceName') ?? '').trim() };
  }

  function add(item: LibraryItem) {
    if (!item.name) { setFeedback({ error: true, text: '名称不能为空。' }); return; }
    const id = crypto.randomUUID();
    const result = store.commit(draft => insertCanvasItem(draft, item, module.id, selection.modulePath, id, centerPlacement, library.config));
    if (result.ok) store.selectInstance([...selection.modulePath, id]);
    setPreview(undefined);
    setFeedback(result.ok ? { text: `已添加「${store.resolveInstance([...selection.modulePath, id])?.instance?.name ?? item.name}」。`, snapshot: store.getSnapshot().project }
      : { error: true, text: result.message });
  }

  function drag(event: DragEvent<HTMLButtonElement>, item: LibraryItem) {
    if (!item.name) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(libraryDragType, JSON.stringify(item));
  }
  return <section className="panel v1-properties" aria-label="离线器件与模块库">
    <button type="button" onClick={() => setManage(true)}>管理器件库</button>
    {manage && <LibraryManager library={library} project={project} selected={selection.instancePath} close={() => setManage(false)} />}
    <label>搜索器件库<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <p className="v1-property-effective">添加到 · {store.resolveInstance(selection.modulePath)?.instance?.name ?? module.name}</p>
    {matches.length > 0 && <ul className="v1-library-items" aria-label="可拖入框图的器件与模块">
      {matches.map(template => {
        const definition = isBlankTemplate(template.id) ? undefined : definitions.get(template.id);
        const conflict = !!definition && definition.kind !== template.kind;
        const item: LibraryItem = { source: 'template', id: template.id, name: template.name, automaticName: true };
        return <li key={template.id}><button type="button" draggable={!conflict} disabled={conflict}
          title={conflict ? '该模板与工程内已有的类型冲突'
            : definition ? `点击或拖入框图，沿用工程定义「${definition.name}」` : '点击添加到当前模块，或拖入框图'}
          onClick={() => add(item)} onDragStart={event => drag(event, item)}>
          <DeviceIcon iconKey={definitionIcon(conflict ? template : definition ?? template)} size={16} />{labels.get(template.id)}
        </button></li>;
      })}
    </ul>}
    {!matches.length && !reusable.length && <p className="empty" role="status">没有匹配的器件或模块。</p>}
    {!!installed.length && <details><summary>高级库设置</summary>
      <p>工程内已有独立快照，可预检并主动更新。</p>
      <label>工程内的模板<select value={templateId} onChange={event => selectTemplate(event.target.value)}>
        {installed.map(item => <option key={item.id} value={item.id}>{labels.get(item.id)}</option>)}
      </select></label>
      <button type="button" onClick={prepareUpdate}>预检从库更新</button>
    </details>}
    {preview && !activePreview && <p role="status">工程或器件库已变化，请重新预检。</p>}
    {activePreview && <div className="v1-property-effective" aria-label="模板更新预检">
      <h3>{activePreview.result.ok ? '预检通过' : '无法更新工程定义'}</h3>
      <p>更新目标「{target?.name}」。已存在的依赖定义沿用工程快照。</p>
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
              <div className="v1-library-diff-values">
                <div>当前工程<pre>{changeValue(change.before, project, change.field)}</pre></div>
                <div>更新后<pre>{changeValue(change.after, compatible.project, change.field)}</pre></div>
              </div>
            </li>
          ))}</ul>
        </details>}
        {!hasChanges && <p>工程定义已与此次更新的内容一致。</p>}
      </>}
      {!activePreview.result.ok && activePreview.result.removedPorts.length > 0 &&
        <p>模板移除端口：{activePreview.result.removedPorts.map(portName).join('、')}</p>}
      {!activePreview.result.ok && <p className="error" role="alert">{activePreview.result.message}</p>}
      <div className="actions">
        <button type="button" onClick={() => setPreview(undefined)}>取消更新</button>
        {activePreview.result.ok ? (hasChanges && <button type="button" onClick={applyUpdate}>确认应用上述变更</button>)
          : activePreview.result.removedPorts.map(port => <button type="button" key={port}
            onClick={() => setUnlink(port)}>预览解绑 {portName(port)}</button>)}
      </div>
    </div>}
    {unlink !== undefined && <PortDeletionDialog store={store} definitionId={templateId} portId={unlink}
      close={() => {
        setUnlink(undefined);
        if (store.getSnapshot().project !== preview?.base) setPreview(undefined);
      }} />}
    {namedOption && <details><summary>按名称添加器件或模块</summary>
      <label>定义<select value={namedOption.key} onChange={event => setDefinitionKey(event.target.value)}>
        {namedOptions.map(({ key, item, source }) => <option key={key} value={key}>
          {(source === 'project' ? projectLabels : labels).get(item.id)} · {source === 'project' ? '工程' : '器件库'}
        </option>)}
      </select></label>
      <form key={namedOption.key} onSubmit={event => {
        event.preventDefault();
        add(selectedItem(event.currentTarget, namedOption.source, namedOption.item.id));
      }}>
        <label>名称<input name="instanceName" defaultValue={namedOption.item.name} required /></label>
        <button type="submit" draggable title="点击放入，或拖入框图" onDragStart={event => {
          const form = event.currentTarget.form;
          if (form) drag(event, selectedItem(form, namedOption.source, namedOption.item.id));
        }}>添加实例</button>
      </form>
    </details>}
    <details><summary>新建空机箱</summary>
      <form onSubmit={event => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const name = String(data.get('name') ?? '').trim();
        if (!name) { setFeedback({ error: true, text: '名称不能为空。' }); return; }
        const id = crypto.randomUUID();
        const enclosure: ModuleDefinition = {
          kind: 'module', id, name, ports: [], instances: [],
          physicalEnclosure: { widthMm: Number(data.get('width')), depthMm: Number(data.get('depth')), heightMm: Number(data.get('height')) },
        };
        const result = store.commit(draft => insertCanvasItem({ ...draft, moduleDefinitions: [...draft.moduleDefinitions, enclosure] },
          { source: 'project', id, name }, module.id, selection.modulePath, id, centerPlacement, library.config));
        if (result.ok) {
          form.reset();
          store.selectInstance([...selection.modulePath, id]);
        }
        setPreview(undefined);
        setFeedback(result.ok ? { text: '已添加「' + name + '」。', snapshot: store.getSnapshot().project }
          : { error: true, text: result.message });
      }}>
        <label>机箱名称<input name="name" required /></label>
        <div className="v1-library-dimensions">
          <label>宽（mm）<input name="width" type="number" min=".001" step="any" defaultValue={440} required /></label>
          <label>深（mm）<input name="depth" type="number" min=".001" step="any" defaultValue={350} required /></label>
          <label>高（mm）<input name="height" type="number" min=".001" step="any" defaultValue={44.45} required /></label>
        </div>
        <button type="submit">新建空机箱</button>
      </form>
    </details>
    {feedback && (!feedback.snapshot || feedback.snapshot === project) &&
      <p role={feedback.error ? 'alert' : 'status'} className={feedback.error ? 'error' : 'v1-property-effective'}>{feedback.text}</p>}
  </section>;
}
