import { useMemo, useState, useSyncExternalStore } from 'react';
import { LayoutEditor } from '../../editors/layout/v1/layout-editor';
import { TopologyEditor } from '../../editors/topology/v1/topology-editor';
import type { Project } from '../../model/v1/types';
import type { ProjectStore } from '../../state/v1/project-store';
import { LibraryPanel } from './library-panel';
import { LinkEditor } from './links/link-editor';
import { createLinkOptions } from './links/link-options';
import { ProfilePanel } from './properties/profile-panel';
import { PropertiesPanel } from './properties/properties-panel';
import './properties/properties.css';

type Props = {
  store: ProjectStore;
  loadExample: () => Project;
  newProject: () => Project;
};

export function Workbench({ store, loadExample, newProject }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { project, selection, canUndo, canRedo } = state;
  const [error, setError] = useState('');
  const [supplies, setSupplies] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  const activeOccurrence = store.resolveInstance(selection.modulePath);
  const active = activeOccurrence?.definition;
  const selected = selection.instancePath && store.resolveInstance(selection.instancePath);
  const properties = selected || activeOccurrence;
  const layout = selection.view === 'topology' ? project.layout?.topology : project.layout?.physical;
  const linkOptions = useMemo(() => createLinkOptions(project), [project]);
  const selectedLink = project.namedLinks?.find(link => link.id === selection.linkId);
  const selectedSources = useMemo(() => {
    const saved = selectedLink && supplies.get(selectedLink.id);
    return saved ? linkOptions.opticalSources.filter(item => saved.includes(item.key)) : [];
  }, [selectedLink, linkOptions, supplies]);
  const pathResult = useMemo(() => selectedLink && linkOptions.resolveNamedLink(selectedLink,
    { opticalSources: selectedSources.map(item => item.value) }), [selectedLink, linkOptions, selectedSources]);

  function openProject(load: () => Project) {
    if ((canUndo || canRedo) && !window.confirm('打开其他工程会清除当前编辑历史。是否继续？')) return;
    const result = store.replaceProject(load());
    setError(result.ok ? '' : result.message);
    if (result.ok) setSupplies(new Map());
  }

  function showTopology() {
    const path = selection.instancePath;
    if (selection.view === 'physical' && path) {
      store.selectModule(path.slice(0, -1));
      store.selectInstance(path);
    }
    store.setView('topology');
  }

  return (
    <>
      <header className="toolbar">
        <div className="brand">persona <span>V1</span></div>
        <div className="actions">
          <button type="button" onClick={() => openProject(newProject)}>新建空工程</button>
          <button type="button" onClick={() => openProject(loadExample)}>加载示例</button>
          <span className="divider" />
          <button type="button" disabled={!canUndo} onClick={() => { store.undo(); setError(''); }}>撤销</button>
          <button type="button" disabled={!canRedo} onClick={() => { store.redo(); setError(''); }}>重做</button>
        </div>
      </header>
      <main className="workspace">
        <section className="heading" aria-labelledby="workbench-title">
          <div>
            <h1 id="workbench-title">V1 工作台</h1>
            <p>{project.name}</p>
          </div>
          <div className="view-switch" role="group" aria-label="视图选择">
            <button type="button" aria-pressed={selection.view === 'topology'} onClick={showTopology}>逻辑拓扑</button>
            <button type="button" aria-pressed={selection.view === 'physical'} onClick={() => store.setView('physical')}>物理布局</button>
          </div>
        </section>
        {selection.view === 'topology' && active?.kind === 'module' &&
          <TopologyEditor key={JSON.stringify(['topology', project.id, selection.modulePath])}
            store={store} state={state} module={active} pathResult={pathResult} />}
        {selection.view === 'physical' &&
          <LayoutEditor key={JSON.stringify(['physical', project.id])} store={store} state={state} />}
        <LinkEditor key={JSON.stringify(['link', project.id, selectedLink?.id])} store={store} project={project}
          options={linkOptions} selected={selectedLink} result={pathResult} sourceKeys={selectedSources.map(item => item.key)}
          setSources={keys => {
            if (selectedLink) setSupplies(previous => new Map(previous).set(selectedLink.id, keys));
          }} />
        <div className="columns">
          <section className="panel" aria-labelledby="module-title">
            <div className="panel-header">
              <h2 id="module-title">当前模块</h2>
              <nav aria-label="模块路径">
                {Array.from({ length: selection.modulePath.length + 1 }, (_, depth) => {
                  const path = selection.modulePath.slice(0, depth);
                  const occurrence = store.resolveInstance(path);
                  const current = depth === selection.modulePath.length;
                  return (
                    <button type="button" key={depth} aria-current={current ? 'location' : undefined}
                      disabled={current} onClick={() => store.selectModule(path)}>
                      {occurrence?.instance?.name ?? occurrence?.definition.name}
                    </button>
                  );
                })}
              </nav>
            </div>
            <ul className="instances">
              {active?.kind === 'module' && active.instances.map(instance => {
                const path = [...selection.modulePath, instance.id];
                const isModule = store.resolveInstance(path)?.definition.kind === 'module';
                const isSelected = selected?.instancePath.length === path.length
                  && path.every((id, index) => id === selected.instancePath[index]);
                return (
                  <li key={instance.id}>
                    <button type="button" aria-pressed={isSelected}
                      onClick={() => store.selectInstance(path)}>{instance.name}</button>
                    {isModule && <button type="button" onClick={() => store.selectModule(path)}
                      aria-label={`进入 ${instance.name}`}>进入</button>}
                  </li>
                );
              })}
            </ul>
            {active?.kind === 'module' && active.instances.length === 0 && <p className="empty">当前模块没有子实例。</p>}
          </section>
          <section className="panel details" aria-labelledby="project-title">
            <h2 id="project-title">工程状态</h2>
            <form key={project.name} onSubmit={event => {
              event.preventDefault();
              const name = (new FormData(event.currentTarget).get('projectName') as string).trim();
              if (!name) { setError('工程名称不能为空。'); return; }
              if (name === project.name) { setError(''); return; }
              const result = store.commit(draft => ({ ...draft, name }));
              setError(result.ok ? '' : result.message);
            }}>
              <label htmlFor="project-name">工程名称</label>
              <div className="form-row">
                <input id="project-name" name="projectName" defaultValue={project.name} required />
                <button className="primary" type="submit">保存名称</button>
              </div>
            </form>
            {error && <p className="error" role="alert">{error}</p>}
            <dl>
              <div><dt>选中实例</dt><dd>{selected?.instance?.name ?? '未选择'}</dd></div>
              <div><dt>布局记录</dt><dd>{layout?.length ?? 0}</dd></div>
            </dl>
          </section>
        </div>
        {active?.kind === 'module' && <LibraryPanel key={JSON.stringify(['library', project.id, selection.modulePath])}
          store={store} state={state} module={active} />}
        {properties && <PropertiesPanel key={JSON.stringify(['properties', project.id, properties.instancePath])}
          store={store} occurrence={properties} />}
        <ProfilePanel key={JSON.stringify(['profiles', project.id])} store={store} profiles={project.conversionProfiles ?? []} />
      </main>
    </>
  );
}
