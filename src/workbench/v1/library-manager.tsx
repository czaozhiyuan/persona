import { creationLabels, libraryGroups } from '../../library/v1/categories';
import { useMemo, useRef, useState } from 'react';
import { resolveHierarchy } from '../../engine/v1/hierarchy';
import { captureInstance, factory, factoryLibrary, libraryDefinitions, parseLibrary, removeDefinition, restoreDefinition, saveDefinition } from '../../library/v1/user-library';
import type { LibraryDefinition } from '../../library/v1/project-snapshots';
import type { InstancePath, Project } from '../../model/v1/types';
import { projectErrorMessage } from '../../storage/v1/project-json';
import { numberedNamesById } from '../../model/v1/display-names';
import { createPathNames } from './structure-scope';
import type { UserLibrary } from './use-library';
import { TemplateEditor } from './template-editor';

export function LibraryManager({ library, project, selected, close }: {
  library: UserLibrary; project: Project; selected?: InstancePath; close: () => void;
}) {
  const { config, replace } = library;
  const definitions = libraryDefinitions(config);
  const labels = numberedNamesById(definitions);
  const [selectedId, select] = useState(definitions[0]?.id);
  const item = definitions.find(d => d.id === selectedId) ?? definitions[0];
  const [draft, edit] = useState<LibraryDefinition[]>();
  const [message, report] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const occurrences = useMemo(() => [...resolveHierarchy(project).walkInstances()], [project]);
  const paths = createPathNames(occurrences);
  const [path, setPath] = useState(JSON.stringify(selected ?? occurrences[0]?.instancePath ?? []));
  const [effective, setEffective] = useState(true);
  function run(action: () => void) {
    try { action(); } catch (error) { report(projectErrorMessage(error)); }
  }
  function downloadJson(content: string, filename: string) {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function start(items: LibraryDefinition[]) { report(''); edit(items); }
  function status(id: string) {
    if (config.hidden.includes(id)) return '内置 · 已隐藏';
    if (config.overrides.some(d => d.id === id)) return '内置 · 已修改';
    return factory.has(id) ? '内置' : '自定义';
  }
  return <dialog className="v1-library-manager v1-properties" aria-label="管理器件库"
    ref={node => { if (node && !node.open) node.showModal(); }} onCancel={close}>
    <header><h2>{draft && labels.has(draft[0].id) ? '编辑模板 · ' + labels.get(draft[0].id) : '管理器件库'}</h2><button type="button" onClick={close}>关闭</button></header>
    {draft ? <TemplateEditor key={draft[0].id} initial={draft[0]} hidden={config.hidden} definitions={[...definitions, ...draft.slice(1)]}
      cancel={() => { edit(undefined); report(''); }} report={report} save={definition => run(() => {
        replace([definition, ...draft.slice(1)].reduce(saveDefinition, config));
        select(definition.id); edit(undefined); report('已保存到器件库。之后创建的对象将使用此模板。');
      })} /> : <>
      <div className="actions">{(['component', 'module'] as const).map(kind => <button key={kind} onClick={() => {
        const base = { id: crypto.randomUUID(), name: '', ports: [] };
        start([kind === 'module' ? { ...base, kind, instances: [] } : { ...base, kind }]);
      }}>{kind === 'component' ? '新建器件模板' : '新建模块模板'}</button>)}</div>
      <label>库模板<select value={item?.id ?? ''} onChange={e => { select(e.target.value); report(''); }}>
        {[...libraryGroups(definitions), { name: '快捷创建', items: definitions.filter(d => creationLabels.has(d.id)) }].map(group =>
          <optgroup key={group.name} label={group.name}>{group.items.map(d =>
            <option key={d.id} value={d.id}>{labels.get(d.id)} · {status(d.id)}</option>)}</optgroup>)}
      </select></label>
      {item && <div className="actions">
        <button onClick={() => start([structuredClone(item)])}>编辑模板</button>
        <button onClick={() => start([{ ...structuredClone(item), id: crypto.randomUUID(), name: item.name + ' 副本' }])}>复制为新模板</button>
        {!config.hidden.includes(item.id) && <button onClick={() => run(() => {
          if (!window.confirm('确认' + (factory.has(item.id) ? '隐藏' : '删除') + '「' + labels.get(item.id) + '」？工程快照将保留。')) return;
          replace(removeDefinition(config, item.id)); report('已更新器件库。');
        })}>{factory.has(item.id) ? '隐藏模板' : '删除模板'}</button>}
        {factory.has(item.id) && <button onClick={() => run(() => {
          replace(restoreDefinition(config, item.id)); report('已恢复出厂模板。');
        })}>恢复此默认条目</button>}
      </div>}
      <details><summary>从工程保存为库模板</summary>
        <label>工程实例<select value={path} onChange={e => setPath(e.target.value)}>
          {occurrences.map(o => <option key={JSON.stringify(o.instancePath)} value={JSON.stringify(o.instancePath)}>
            {paths.showPath(o.instancePath)}</option>)}
        </select></label>
        <label><input type="checkbox" checked={effective} onChange={e => setEffective(e.target.checked)} />将当前实例有效参数保存为模板默认值</label>
        <button onClick={() => run(() => start(captureInstance(project, JSON.parse(path), effective)))}>复制工程快照</button>
      </details>
      <p role="status">{library.status}</p>
      {library.conflict && <button onClick={() => {
        if (window.confirm('重新载入会替换本页的器件库。请先导出要保留的本页修改，并确认文件已保存。继续载入？')) {
          library.reload(); report('');
        }
      }}>重新载入浏览器中的库</button>}
      <details open><summary>库备份与恢复</summary>
        <div className="actions"><button onClick={() => run(() => {
          downloadJson(JSON.stringify(config, null, 2), 'persona-library.json');
          library.markDownloadRequested();
        })}>导出器件库 JSON</button>
        {library.damaged && library.source && <button onClick={() => downloadJson(library.source!, 'persona-library-original.json')}>导出浏览器原始库 JSON</button>}
        <button onClick={() => file.current?.click()}>导入器件库 JSON</button>
        <input type="file" hidden ref={file} accept=".json,application/json" onChange={async e => {
          const source = e.target.files?.[0]; e.target.value = '';
          if (!source) return;
          try {
            const next = parseLibrary(await source.text());
            if (window.confirm('导入将替换当前的自定义模板、内置修改和隐藏记录。建议先导出备份。确认替换？')) {
              replace(next, true); report('已导入器件库。');
            }
          } catch (error) { report(projectErrorMessage(error)); }
        }} />
        <button onClick={() => run(() => {
          if (window.confirm('恢复全部默认库将移除所有自定义模板、内置修改和隐藏记录。建议先导出备份。确认恢复？')) {
            replace(factoryLibrary(), true); report('已恢复全部默认库。');
          }
        })}>恢复全部默认库</button></div>
        <p>{library.downloadRequested ? '已请求下载当前库 JSON，请确认文件已保存。' : '尚未请求下载当前库 JSON。'}</p>
      </details>
    </>}
    {message && <p role="status">{message}</p>}
  </dialog>;
}
