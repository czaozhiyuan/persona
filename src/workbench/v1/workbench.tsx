import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { LayoutEditor } from '../../editors/layout/v1/layout-editor';
import { TopologyEditor } from '../../editors/topology/v1/topology-editor';
import { createLinkBudget } from '../../engine/v1/link-budget';
import type { LinkBudgetConditions } from '../../engine/v1/link-budget';
import { signalPortKey } from '../../engine/v1/signal-graph';
import type { Project } from '../../model/v1/types';
import type { ProjectStore } from '../../state/v1/project-store';
import { parseProjectJson, serializeProjectJson } from '../../storage/v1/project-json';
import { DcBudgetPanel } from './budgets/dc-budget-panel';
import { LocalOpticalPanel } from './budgets/local-optical-panel';
import type { LocalOpticalSettings } from './budgets/local-optical-panel';
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

type Page = 'canvas' | 'project' | 'links' | 'library' | 'properties' | 'profiles' | 'optical-budget' | 'dc-budget';
const emptyBudgetConditions: LinkBudgetConditions = {};

function closeWorkbenchMenu() {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>('.v1-main-menu details[open]')) menu.open = false;
}

export function Workbench({ store, loadExample, newProject }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { project, selection, canUndo, canRedo } = state;
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const importAttempt = useRef(0);
  const [projectSession, setProjectSession] = useState(0);
  const [page, setPage] = useState<Page>('canvas');
  const [treeHidden, setTreeHidden] = useState(() => window.matchMedia('(max-width: 46rem)').matches);
  const [expandedHierarchy, setExpandedHierarchy] = useState<ReadonlySet<string>>(new Set(['[]']));
  const [linkInputs, setLinkInputs] = useState<ReadonlyMap<string, LinkBudgetConditions>>(new Map());
  const [localOptical, setLocalOptical] = useState<LocalOpticalSettings>({ sources: [] });
  const activeOccurrence = store.resolveInstance(selection.modulePath);
  const active = activeOccurrence?.definition;
  const selected = selection.instancePath && store.resolveInstance(selection.instancePath);
  const properties = selected || activeOccurrence;
  const layout = selection.view === 'topology' ? project.layout?.topology : project.layout?.physical;
  const linkOptions = useMemo(() => createLinkOptions(project), [project]);
  const budget = useMemo(() => createLinkBudget(project), [project]);
  const selectedLink = project.namedLinks?.find(link => link.id === selection.linkId);
  const savedConditions = (selectedLink && linkInputs.get(selectedLink.id)) || emptyBudgetConditions;
  const conditions = useMemo(() => {
    const ports = new Set(linkOptions.opticalSources.map(option => option.key));
    return { ...savedConditions, opticalSources: savedConditions.opticalSources?.filter(source =>
      ports.has(signalPortKey(source.endpoint))) };
  }, [linkOptions, savedConditions]);
  const pathResult = useMemo(() => selectedLink && budget.resolveNamedLink(selectedLink, conditions),
    [selectedLink, budget, conditions]);

  useEffect(() => {
    function dismiss(event: PointerEvent | KeyboardEvent) {
      if (!(event.target instanceof Element)) return;
      if (event instanceof KeyboardEvent && (event.key !== 'Escape' || document.querySelector('dialog[open]'))) return;
      for (const popup of document.querySelectorAll<HTMLDetailsElement>('details[data-workbench-popup][open]')) {
        if (event instanceof PointerEvent && popup.contains(event.target)) continue;
        popup.open = false;
        if (event instanceof KeyboardEvent) popup.querySelector('summary')?.focus();
      }
    }
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismiss);
    };
  }, []);

  function replaceProject(candidate: Project) {
    const result = store.replaceProject(candidate);
    setError(result.ok ? '' : result.message);
    if (result.ok) {
      importAttempt.current++;
      setProjectSession(session => session + 1);
      setLinkInputs(new Map());
      setLocalOptical({ sources: [] });
      setExpandedHierarchy(new Set(['[]']));
      setPage('canvas');
    }
  }

  function openProject(load: () => Project) {
    closeWorkbenchMenu();
    if ((canUndo || canRedo) && !window.confirm('打开其他工程会清除当前编辑历史。是否继续？')) return;
    try {
      replaceProject(load());
    } catch (error) {
      setError(`打开工程失败：${(error as Error).message}`);
    }
  }

  async function openProjectFile(file: File) {
    const attempt = ++importAttempt.current;
    try {
      const source = await file.text();
      if (attempt !== importAttempt.current) return;
      const candidate = parseProjectJson(source);
      if (!window.confirm(`打开「${candidate.name}」会替换当前工程并清除编辑历史。是否继续？`)) return;
      replaceProject(candidate);
    } catch (error) {
      if (attempt === importAttempt.current) setError(`无法打开「${file.name}」：${(error as Error).message}`);
    }
  }

  function downloadProject() {
    closeWorkbenchMenu();
    try {
      const json = serializeProjectJson(store.getSnapshot().project);
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'persona-project.json';
      link.hidden = true;
      try {
        document.body.append(link);
        link.click();
        setError('');
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (error) {
      setError(`保存工程失败：${(error as Error).message}`);
    }
  }

  function openPage(next: Page) {
    closeWorkbenchMenu();
    setPage(next);
  }

  function showTopology() {
    const path = selection.instancePath;
    if (selection.view === 'physical' && path) {
      store.selectModule(path.slice(0, -1));
      store.selectInstance(path);
    }
    store.setView('topology');
    openPage('canvas');
  }

  return (
    <div className="v1-workbench">
      <header className="toolbar">
        <div className="brand">persona <span>V1</span></div>
        <span className="divider" />
        <nav className="v1-main-menu" aria-label="工作台菜单">
          <details name="workbench-menu" data-workbench-popup><summary>工程</summary>
            <div className="v1-menu-items">
              <button type="button" onClick={() => openProject(newProject)}>新建空工程</button>
              <button type="button" onClick={() => openProject(loadExample)}>加载示例</button>
                <button type="button" onClick={() => { closeWorkbenchMenu(); fileInput.current?.click(); }}>打开工程 JSON</button>
                <button type="button" onClick={downloadProject}>保存工程 JSON</button>
              <button type="button" onClick={() => openPage('project')}>工程状态</button>
            </div>
          </details>
          <details name="workbench-menu" data-workbench-popup><summary>链路</summary>
            <div className="v1-menu-items"><button type="button" onClick={() => openPage('links')}>命名链路</button></div>
          </details>
          <details name="workbench-menu" data-workbench-popup><summary>预算</summary>
            <div className="v1-menu-items">
              <button type="button" onClick={() => openPage('optical-budget')}>局部光功率</button>
              <button type="button" onClick={() => openPage('dc-budget')}>DC 供电预算</button>
            </div>
          </details>
          <details name="workbench-menu" data-workbench-popup><summary>器件库</summary>
            <div className="v1-menu-items"><button type="button" disabled={active?.kind !== 'module'}
              onClick={() => openPage('library')}>器件与模块库</button></div>
          </details>
          <details name="workbench-menu" data-workbench-popup><summary>属性与标定</summary>
            <div className="v1-menu-items">
              <button type="button" disabled={!properties} onClick={() => openPage('properties')}>对象属性</button>
              <button type="button" onClick={() => openPage('profiles')}>工程标定 Profile</button>
            </div>
          </details>
        </nav>
        <span className="divider" />
        <div className="actions">
          <button type="button" aria-label="撤销" title="撤销" disabled={!canUndo} onClick={() => { store.undo(); setError(''); }}>↶</button>
          <button type="button" aria-label="重做" title="重做" disabled={!canRedo} onClick={() => { store.redo(); setError(''); }}>↷</button>
        </div>
        <div className="view-switch" role="group" aria-label="视图选择">
          <button type="button" aria-pressed={page === 'canvas' && selection.view === 'topology'} onClick={showTopology}>逻辑拓扑</button>
          <button type="button" aria-pressed={page === 'canvas' && selection.view === 'physical'}
            onClick={() => { store.setView('physical'); openPage('canvas'); }}>物理布局</button>
        </div>
      </header>
      <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label="工程 JSON 文件"
        onChange={event => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          input.value = '';
          if (file) void openProjectFile(file);
        }} />
      {error && <p className="v1-workbench-notice error" role="alert">{error}</p>}
      <main className="v1-workbench-main">
        <div className="v1-canvas-page" inert={page !== 'canvas'} aria-hidden={page !== 'canvas'}>
        {selection.view === 'topology' && active?.kind === 'module' &&
          <TopologyEditor key={JSON.stringify(['topology', projectSession, project.id, selection.modulePath])}
            store={store} state={state} module={active} pathResult={pathResult} graph={linkOptions.graph}
            expandedHierarchy={expandedHierarchy} setExpandedHierarchy={setExpandedHierarchy}
            treeHidden={treeHidden} setTreeHidden={setTreeHidden} />}
        {selection.view === 'physical' &&
          <div className="v1-page-scroll"><div className="workspace">
            <LayoutEditor key={JSON.stringify(['physical', projectSession, project.id])} store={store} state={state} />
          </div></div>}
        </div>
        {page !== 'canvas' && <div className="v1-page-scroll">
          <div className="workspace">
        {page === 'links' && <LinkEditor key={JSON.stringify(['link', project.id, selectedLink?.id])} store={store} project={project}
          options={linkOptions} selected={selectedLink} result={pathResult} budget={budget} conditions={conditions}
          setConditions={next => {
            if (selectedLink) setLinkInputs(previous => new Map(previous).set(selectedLink.id, next));
          }} />}
        {page === 'project' && <div className="columns">
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
            <dl>
              <div><dt>选中实例</dt><dd>{selected?.instance?.name ?? '未选择'}</dd></div>
              <div><dt>布局记录</dt><dd>{layout?.length ?? 0}</dd></div>
            </dl>
          </section>
        </div>}
        {page === 'library' && active?.kind === 'module' && <LibraryPanel key={JSON.stringify(['library', project.id, selection.modulePath])}
          store={store} state={state} module={active} />}
        {page === 'properties' && properties && <PropertiesPanel key={JSON.stringify(['properties', project.id, properties.instancePath])}
          store={store} occurrence={properties} />}
        {page === 'profiles' && <ProfilePanel key={JSON.stringify(['profiles', project.id])} store={store} profiles={project.conversionProfiles ?? []} />}
        {page === 'optical-budget' && <LocalOpticalPanel options={linkOptions} settings={localOptical} onChange={setLocalOptical} />}
        {page === 'dc-budget' && <DcBudgetPanel project={project} />}
          </div>
        </div>}
      </main>
    </div>
  );
}
