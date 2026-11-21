import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { LayoutEditor } from '../../editors/layout/v1/layout-editor';
import { HierarchyTree } from '../../editors/topology/v1/hierarchy-tree';
import { hierarchyKey } from '../../editors/topology/v1/hierarchy-view';
import { TopologyEditor } from '../../editors/topology/v1/topology-editor';
import { createLinkBudget } from '../../engine/v1/link-budget';
import { createOpticalBudgetForGraph } from '../../engine/v1/optical-budget';
import type { LinkTrial, NamedLink } from '../../model/v1/topology';
import { signalPortKey } from '../../engine/v1/signal-graph';
import type { EndpointRef, InstancePath, PortDefinition, Project } from '../../model/v1/types';
import type { ProjectStore } from '../../state/v1/project-store';
import { parseProjectJson, serializeProjectJson } from '../../storage/v1/project-json';
import type { BudgetHighlight } from '../../editors/topology/v1/path-highlight';
import { BudgetDock, enclosureContains } from './budgets/budget-dock';
import { projectFileName, sameTrial } from './budgets/trial-conditions';
import { DcBudgetPanel } from './budgets/dc-budget-panel';
import { LocalOpticalPanel } from './budgets/local-optical-panel';
import type { LocalOpticalSettings } from './budgets/local-optical-panel';
import { LibraryPanel } from './library-panel';
import { LinkEditor } from './links/link-editor';
import { createLinkOptions } from './links/link-options';
import { ProfilePanel } from './properties/profile-panel';
import { addDefinitionPort } from '../../state/v1/module-ports';
import { AddPortDialog } from './properties/add-port-dialog';
import { structureScope } from './structure-scope';
import { PropertiesPanel } from './properties/properties-panel';
import { returnToTopology } from './view-navigation';
import type { TopologyLocation } from './view-navigation';
import './properties/properties.css';

type Props = {
  store: ProjectStore;
  loadExample: () => Project;
  newProject: () => Project;
};

type Page = 'canvas' | 'project' | 'profiles';
type BudgetPage = 'links' | 'optical' | 'dc';
const budgetTitles = { links: '查看链路预算', optical: '局部光功率', dc: '供电与功耗' };
const defaultTrial: LinkTrial = { frequencyGHz: 1 };

function closeWorkbenchMenu() {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>('.v1-main-menu details[open]')) menu.open = false;
}

export function Workbench({ store, loadExample, newProject }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { project, selection, canUndo, canRedo } = state;
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const importAttempt = useRef(0);
  const topologyLocation = useRef<TopologyLocation | undefined>(undefined);
  const [projectSession, setProjectSession] = useState(0);
  const [portTarget, setPortTarget] = useState<InstancePath>();
  const [newPort, setNewPort] = useState<EndpointRef>();
  const [page, setPage] = useState<Page>('canvas');
  const [savedProject, setSavedProject] = useState(project);
  const modified = project !== savedProject;
  const [dock, setDock] = useState<BudgetPage>();
  const [collapsed, setCollapsed] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const [draftLink, setDraftLink] = useState<NamedLink>();
  const [opticalTarget, setOpticalTarget] = useState<EndpointRef>();
  const [dcScope, setDcScope] = useState<InstancePath>();
  const [leftTab, setLeftTab] = useState<'structure' | 'library' | undefined>(() =>
    window.matchMedia('(max-width: 48rem)').matches ? undefined : 'structure');
  const [propertiesOpen, setPropertiesOpen] = useState(() => !window.matchMedia('(max-width: 48rem)').matches);
  const [expandedHierarchy, setExpandedHierarchy] = useState<ReadonlySet<string>>(new Set(['[]']));
  const [expandedCanvas, setExpandedCanvas] = useState<ReadonlySet<string>>(new Set());
  const [linkInputs, setLinkInputs] = useState<ReadonlyMap<string, LinkTrial>>(new Map());
  const [localOptical, setLocalOptical] = useState<LocalOpticalSettings>({ sources: [] });
  const activeOccurrence = store.resolveInstance(selection.modulePath);
  const active = activeOccurrence?.definition;
  const selected = selection.instancePath && store.resolveInstance(selection.instancePath);
  const properties = selected || activeOccurrence;
  const targetPortOwner = portTarget && store.resolveInstance(portTarget);
  const layout = selection.view === 'topology' ? project.layout?.topology : project.layout?.physical;
  const linkOptions = useMemo(() => createLinkOptions(project), [project]);
  const budget = useMemo(() => createLinkBudget(project), [project]);
  const savedLink = project.namedLinks?.find(link => link.id === selection.linkId);
  const selectedLink = savedLink ?? draftLink;
  const activeTrial = selectedLink ? linkInputs.get(selectedLink.id) ?? selectedLink.trial ?? defaultTrial : defaultTrial;
  const conditions = useMemo(() => {
    const ports = new Set(linkOptions.opticalSources.map(option => option.key));
    return { ...activeTrial, opticalSources: activeTrial.opticalSources?.filter(source => ports.has(signalPortKey(source.endpoint))) };
  }, [linkOptions, activeTrial]);
  const pathResult = useMemo(() => dock === 'links' && selectedLink ? budget.resolveNamedLink(selectedLink, conditions) : undefined,
    [dock, selectedLink, budget, conditions]);
  const opticalBudget = useMemo(() => createOpticalBudgetForGraph(linkOptions.graph), [linkOptions]);
  const opticalResult = useMemo(() => {
    const query = localOptical.query;
    return dock === 'optical' && query ? opticalBudget.calculateLocal('eo' in query ? { ...query, sources: localOptical.sources } : query) : undefined;
  }, [dock, localOptical, opticalBudget]);
  const linkedOpticalResult = useMemo(() => {
    const { from, to, channelId, via } = selectedLink ?? {};
    if (pathResult?.status !== 'resolved' || !from || !to || !channelId || via?.length || pathResult.trace.conversions.length) return undefined;
    if (linkOptions.graph.ports.get(signalPortKey(to))?.definition.type !== 'OPTICAL') return undefined;
    const source = conditions.opticalSources?.find(item => signalPortKey(item.endpoint) === signalPortKey(from) && item.channelId === channelId);
    return source && opticalBudget.calculateLocal({ source, to });
  }, [selectedLink, pathResult, conditions, linkOptions, opticalBudget]);
  const budgetHighlight = useMemo((): BudgetHighlight | undefined => {
    if (dock === 'links') return { endpoints: [selectedLink?.from, selectedLink?.to].filter(ref => ref !== undefined) };
    if (dock === 'optical') return {
      endpoints: [localOptical.query?.to ?? opticalTarget, ...(opticalResult?.stages.map(stage => stage.endpoint) ?? [])]
        .filter(ref => ref !== undefined),
      edges: opticalResult?.stages.flatMap(stage => stage.incoming ? [stage.incoming.edge] : []),
    };
    if (dock === 'dc' && dcScope) {
      const inside = enclosureContains(project, dcScope);
      const ports = [...linkOptions.graph.ports.values()].filter(port => port.definition.type === 'DC_POWER' && inside(port.ref.instancePath));
      const keys = new Set(ports.map(port => signalPortKey(port.ref)));
      return { endpoints: ports.map(port => port.ref), edges: linkOptions.graph.edges.filter(edge =>
        edge.from.definition.type === 'DC_POWER' && edge.to.definition.type === 'DC_POWER'
        && (keys.has(signalPortKey(edge.from.ref)) || keys.has(signalPortKey(edge.to.ref)))) };
    }
  }, [dock, selectedLink, opticalTarget, localOptical, opticalResult, dcScope, project, linkOptions]);
  const showDock = dock && page === 'canvas';

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

  useEffect(() => {
    setExpandedHierarchy(current => {
      const next = new Set(current);
      for (let depth = 0; depth <= selection.modulePath.length; depth++) {
        next.add(hierarchyKey(selection.modulePath.slice(0, depth)));
      }
      return next.size === current.size ? current : next;
    });
  }, [selection.modulePath]);

  function toggleBranch(path: InstancePath) {
    setExpandedHierarchy(current => {
      const next = new Set(current);
      const key = hierarchyKey(path);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function navigate(path: InstancePath, isModule: boolean) {
    if (isModule) {
      store.selectModule(path);
      store.selectInstance(undefined);
    } else {
      store.selectModule(path.slice(0, -1));
      store.selectInstance(path);
    }
    openPage('canvas');
  }

  function replaceProject(candidate: Project) {
    const result = store.replaceProject(candidate);
    setError(result.ok ? '' : result.message);
    if (result.ok) {
      setSavedProject(store.getSnapshot().project);
      setDock(undefined);
      setDraftLink(undefined);
      setOpticalTarget(undefined);
      setDcScope(undefined);
      importAttempt.current++;
      topologyLocation.current = undefined;
      setProjectSession(session => session + 1);
      setPortTarget(undefined);
      setNewPort(undefined);
      setLinkInputs(new Map());
      setLocalOptical({ sources: [] });
      setExpandedHierarchy(new Set(['[]']));
      setExpandedCanvas(new Set());
      setPage('canvas');
    }
  }

  function openProject(load: () => Project) {
    closeWorkbenchMenu();
    if (modified && !window.confirm('当前工程有未保存的修改。是否继续打开其他工程？')) return;
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
      const snapshot = store.getSnapshot().project;
      const json = serializeProjectJson(snapshot);
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = projectFileName(snapshot.name);
      link.hidden = true;
      try {
        document.body.append(link);
        link.click();
        setSavedProject(snapshot);
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

  function openBudget(kind: BudgetPage) {
    if (dock !== kind) setEnlarged(false);
    setDock(kind);
    setCollapsed(false);
    openPage('canvas');
  }

  function chooseLink(id?: string) {
    setDraftLink(undefined);
    store.selectLink(id);
  }

  function showLinks() {
    if (!selectedLink) store.selectLink(project.namedLinks?.find(link => link.trial)?.id);
    openBudget('links');
  }

  function showDc(scope?: InstancePath) {
    setDcScope(scope);
    openBudget('dc');
  }

  function selectBudgetPort(action: 'optical' | 'from' | 'to', ref: EndpointRef) {
    if (action === 'optical') {
      setOpticalTarget(ref);
      setLocalOptical({ sources: [] });
      openBudget('optical');
    } else {
      setDraftLink({ ...(savedLink ? { id: crypto.randomUUID(), name: '新链路' } : draftLink ??
        { id: crypto.randomUUID(), name: '新链路' }), [action]: ref });
      store.selectLink(undefined);
      openBudget('links');
    }
  }

  function saveTrial() {
    if (!savedLink || sameTrial(savedLink.trial, conditions)) return;
    const result = store.commit(draft => ({
      ...draft, namedLinks: draft.namedLinks?.map(link => link.id === savedLink.id ? { ...link, trial: conditions } : link),
    }));
    setError(result.ok ? '' : result.message);
    if (result.ok) setLinkInputs(current => {
      const next = new Map(current);
      next.delete(savedLink.id);
      return next;
    });
  }

  function locateBudgetPort(ref: EndpointRef) {
    navigatePort(ref.instancePath, ref.portId);
    setEnlarged(false);
    requestAnimationFrame(() => {
      const fit = document.querySelector<HTMLButtonElement>('.v1-topology button[aria-label="定位选中"]:enabled')
        ?? document.querySelector<HTMLButtonElement>('.v1-topology button[aria-label="适应画布"]');
      fit?.click();
    });
  }

  function jumpToParameter(path: InstancePath, parameterId: string) {
    store.selectModule(path.slice(0, -1));
    store.selectInstance(path.length ? path : undefined);
    store.setView('topology');
    setPropertiesOpen(true);
    openPage('canvas');
    requestAnimationFrame(() => {
      const owner = store.resolveInstance(path);
      const parameter = owner?.definition.parameters?.find(item => item.id === parameterId);
      const field = owner?.instance && parameter?.overridable ? 'effective' : 'definition';
      const target = document.querySelector<HTMLDetailsElement>(
        `#workbench-properties [data-${field}-parameter="${CSS.escape(parameterId)}"]`);
      if (!target) return;
      for (let details: HTMLDetailsElement | null = target; details; details = details.parentElement?.closest('details') ?? null) {
        details.open = true;
      }
      target.querySelector('summary')?.focus();
      target.scrollIntoView({ block: 'nearest' });
    });
  }

  function navigatePort(path: InstancePath, portId: string) {
    navigate(path, store.resolveInstance(path)?.definition.kind === 'module');
    store.setView('topology');
    setPropertiesOpen(true);
    requestAnimationFrame(() => {
      const port = document.querySelector<HTMLDetailsElement>(`#workbench-properties [data-port-id="${CSS.escape(portId)}"]`);
      if (!port) return;
      port.open = true;
      port.querySelector('summary')?.focus();
      port.scrollIntoView({ block: 'nearest' });
    });
  }

  function addPort(port: PortDefinition) {
    if (!targetPortOwner) return '目标对象已不存在。';
    const result = store.commit(draft => addDefinitionPort(draft, targetPortOwner.definition.id, port));
    if (!result.ok) return result.message;
    setNewPort({ instancePath: targetPortOwner.instancePath, portId: port.id });
  }

  function renameSelection() {
    setPropertiesOpen(true);
    requestAnimationFrame(() => {
      const name = document.querySelector<HTMLInputElement>('#workbench-properties [data-object-name]');
      name?.focus();
      name?.select();
    });
  }

  function showTopology() {
    returnToTopology(store, topologyLocation.current);
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
          <details name="workbench-menu" data-workbench-popup><summary>计算</summary>
            <div className="v1-menu-items">
              <button type="button" onClick={showLinks}>查看链路预算</button>
              <button type="button" onClick={() => { setOpticalTarget(undefined); openBudget('optical'); }}>局部光功率</button>
              <button type="button" onClick={() => showDc()}>直流供电预算</button>
              <button type="button" onClick={() => openPage('profiles')}>工程标定方案</button>
            </div>
          </details>
        </nav>
        <span className="divider" />
        <div className="actions">
          <button type="button" aria-label="撤销" title="撤销" disabled={!canUndo} onClick={() => { store.undo(); setError(''); }}>↶</button>
          <button type="button" aria-label="重做" title="重做" disabled={!canRedo} onClick={() => { store.redo(); setError(''); }}>↷</button>
        </div>
        <div className="v1-project-heading">
          <button className="v1-project-name" type="button" onClick={() => openPage('project')}
            title={project.name}>{project.name}</button>
          <span className="v1-project-status" role="status" data-modified={modified}>{modified ? '未保存' : '无未保存修改'}</span>
        </div>
        <div className="view-switch" role="group" aria-label="视图选择">
          <button type="button" aria-pressed={page === 'canvas' && selection.view === 'topology'} onClick={showTopology}>框图</button>
          <button type="button" aria-pressed={page === 'canvas' && selection.view === 'physical'}
            onClick={() => {
              if (selection.view === 'topology') topologyLocation.current = selection;
              store.setView('physical');
              openPage('canvas');
            }}>机箱布局</button>
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
      <div className="v1-workbench-body" data-left-open={leftTab !== undefined} data-right-open={propertiesOpen}>
        <aside className="v1-side v1-side-left" aria-label="结构与器件库">
          <div className="v1-side-tools">
            <button type="button" aria-expanded={leftTab === 'structure'} aria-controls="workbench-structure"
              onClick={() => setLeftTab(current => current === 'structure' ? undefined : 'structure')}>结构</button>
            <button type="button" aria-expanded={leftTab === 'library'} aria-controls="workbench-library"
              onClick={() => setLeftTab(current => current === 'library' ? undefined : 'library')}>器件库</button>
          </div>
          <div id="workbench-structure" className="v1-side-scroll" hidden={leftTab !== 'structure'}>
            <HierarchyTree instances={linkOptions.graph.instances} modulePath={selection.modulePath}
              selected={selection.instancePath} expanded={expandedHierarchy} toggle={toggleBranch} navigate={navigate} navigatePort={navigatePort} />
          </div>
          <div id="workbench-library" className="v1-side-scroll" hidden={leftTab !== 'library'}>
            {active?.kind === 'module' && <LibraryPanel key={projectSession} store={store} state={state} module={active} />}
          </div>
        </aside>
        <main className="v1-workbench-main" data-budget={showDock ? collapsed ? 'collapsed' : enlarged ? 'enlarged' : 'open' : undefined}>
          <div className="v1-canvas-page" inert={page !== 'canvas' || selection.view !== 'topology'}
            aria-hidden={page !== 'canvas' || selection.view !== 'topology'}>
            {active?.kind === 'module' &&
              <TopologyEditor key={JSON.stringify(['topology', projectSession, selection.modulePath])}
                store={store} state={state} module={active} pathResult={pathResult} graph={linkOptions.graph} rename={renameSelection}
                expanded={expandedCanvas} setExpanded={setExpandedCanvas} budgetHighlight={budgetHighlight}
                onPortBudget={selectBudgetPort} onDcBudget={showDc} onAddPort={setPortTarget} newPort={newPort} />}
          </div>
          <div className="v1-canvas-page v1-layout-scroll" inert={page !== 'canvas' || selection.view !== 'physical'}
            aria-hidden={page !== 'canvas' || selection.view !== 'physical'}>
            <LayoutEditor key={projectSession} store={store} state={state} onDcBudget={showDc} />
          </div>
        {page !== 'canvas' && <div className="v1-page-scroll">
          <div className="workspace">
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
                const occurrence = store.resolveInstance(path);
                const isModule = occurrence?.definition.kind === 'module';
                const name = occurrence?.instance?.name ?? instance.name;
                const isSelected = selected?.instancePath.length === path.length
                  && path.every((id, index) => id === selected.instancePath[index]);
                return (
                  <li key={instance.id}>
                    <button type="button" aria-pressed={isSelected}
                      onClick={() => store.selectInstance(path)}>{name}</button>
                    {isModule && <button type="button" onClick={() => store.selectModule(path)}
                      aria-label={`进入 ${name}`}>进入</button>}
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
            <p>工程 JSON 保存拓扑、参数、布局、链路和主动保存的试算条件。临时供光输入与预算结果留在本次会话，结果由当前工程重新计算。</p>
            <dl>
              <div><dt>选中实例</dt><dd>{selected?.instance?.name ?? '未选择'}</dd></div>
              <div><dt>布局记录</dt><dd>{layout?.length ?? 0}</dd></div>
            </dl>
          </section>
        </div>}
        {page === 'profiles' && <ProfilePanel key={JSON.stringify(['profiles', project.id])} store={store} profiles={project.conversionProfiles ?? []} />}
           </div>
        </div>}
          {showDock && dock && <BudgetDock title={budgetTitles[dock]} collapsed={collapsed} enlarged={enlarged}
            toggle={() => setCollapsed(value => !value)} enlarge={() => setEnlarged(value => !value)}
            close={() => setDock(undefined)}>
            {dock === 'links' && <LinkEditor key={JSON.stringify([selectedLink?.id, !savedLink && draftLink?.from, !savedLink && draftLink?.to])} store={store} project={project}
              options={linkOptions} draft={!savedLink && !!draftLink} selected={selectedLink} result={pathResult} budget={budget}
              conditions={conditions} opticalResult={linkedOpticalResult} trialSaved={sameTrial(savedLink?.trial, conditions)}
              saveTrial={saveTrial} choose={chooseLink} locate={locateBudgetPort}
              setDraftChannel={channelId => setDraftLink(current => current && { ...current, channelId })}
              setConditions={next => {
                if (selectedLink) setLinkInputs(previous => new Map(previous).set(selectedLink.id, next));
              }} />}
            {dock === 'optical' && <LocalOpticalPanel key={opticalTarget && signalPortKey(opticalTarget)} options={linkOptions}
              settings={localOptical} onChange={setLocalOptical} target={opticalTarget} result={opticalResult} locate={locateBudgetPort} />}
            {dock === 'dc' && <DcBudgetPanel project={project} labels={linkOptions} scope={dcScope} locate={locateBudgetPort} />}
          </BudgetDock>}
        </main>
        <aside className="v1-side v1-side-right" aria-label="属性栏">
          <div className="v1-side-tools">
            <button type="button" aria-expanded={propertiesOpen} aria-controls="workbench-properties"
              onClick={() => setPropertiesOpen(open => !open)}>属性</button>
          </div>
          <div id="workbench-properties" className="v1-side-scroll" hidden={!propertiesOpen}>
            {properties && <PropertiesPanel key={JSON.stringify([projectSession, properties.instancePath])}
              store={store} occurrence={properties} occurrences={linkOptions.graph.instances} jumpToParameter={jumpToParameter} onAddPort={setPortTarget} />}
          </div>
        </aside>
      </div>
      {targetPortOwner && <AddPortDialog name={targetPortOwner.instance?.name ?? targetPortOwner.definition.name}
        locations={structureScope(linkOptions.graph.instances, targetPortOwner.definition.id)}
        add={addPort} close={() => setPortTarget(undefined)} />}
    </div>
  );
}
