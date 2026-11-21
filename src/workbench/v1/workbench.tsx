import type { XYPosition } from '@xyflow/react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { LayoutEditor } from '../../editors/layout/v1/layout-editor';
import { HierarchyTree } from '../../editors/topology/v1/hierarchy-tree';
import { hierarchyKey, inHierarchy } from '../../editors/topology/v1/hierarchy-view';
import type { ApprovedMove, ReparentLayout } from '../../editors/topology/v1/reparent-drop';
import type { CanvasView } from '../../editors/topology/v1/canvas-controls';
import { TopologyEditor } from '../../editors/topology/v1/topology-editor';
import { createLinkBudget } from '../../engine/v1/link-budget';
import { createOpticalBudgetForGraph } from '../../engine/v1/optical-budget';
import type { LinkTrial, NamedLink } from '../../model/v1/topology';
import { signalPortKey } from '../../engine/v1/signal-graph';
import type { EndpointRef, InstancePath, PortDefinition, Project } from '../../model/v1/types';
import { pasteModule } from '../../state/v1/instantiate-module';
import { planDissolveModule } from '../../state/v1/dissolve-module';
import { moveWiringSummary, planInstanceMove } from '../../state/v1/reparent-instance';
import { moveTopologyNodes, resizeTopologyFrame } from '../../state/v1/topology-edits';
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
import { structureLocations, structureScope } from './structure-scope';
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
type SideTab = 'structure' | 'library';
type Presentation = {
  view: CanvasView;
  scope: InstancePath;
  selected: readonly InstancePath[];
  leftTab?: SideTab;
  propertiesOpen: boolean;
  dock?: BudgetPage;
  collapsed: boolean;
  enlarged: boolean;
  expandedCanvas: ReadonlySet<string>;
  expandedHierarchy: ReadonlySet<string>;
};
const budgetTitles = { links: '查看链路预算', optical: '局部光功率', dc: '供电与功耗' };
const defaultTrial: LinkTrial = { frequencyGHz: 1 };

function closeWorkbenchMenu() {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>('.v1-main-menu details[open]')) menu.open = false;
}

export function Workbench({ store, loadExample, newProject }: Props) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { project, selection, canUndo, canRedo } = state;
  const [error, setError] = useState('');
  const [copyNotice, setCopyNotice] = useState('');
  const moduleClipboard = useRef<{ project: Project; path: InstancePath; ports: readonly PortDefinition[] }>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const importAttempt = useRef(0);
  const topologyLocation = useRef<TopologyLocation | undefined>(undefined);
  const [projectSession, setProjectSession] = useState(0);
  const [portTarget, setPortTarget] = useState<InstancePath>();
  const [newPort, setNewPort] = useState<EndpointRef>();
  const [focusMoved, setFocusMoved] = useState<{ path: InstancePath; centerCanvas: boolean }>();
  const [dissolve, setDissolve] = useState<{ base: Project; plan: ReturnType<typeof planDissolveModule>; destination: string; error?: string }>();
  const [moveUp, setMoveUp] = useState<{ base: Project; plan: ReturnType<typeof planInstanceMove>; destination: string; error?: string }>();
  const [page, setPage] = useState<Page>('canvas');
  const topologyActive = page === 'canvas' && selection.view === 'topology';
  const [savedProject, setSavedProject] = useState(project);
  const modified = project !== savedProject;
  const [dock, setDock] = useState<BudgetPage>();
  const [collapsed, setCollapsed] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const [draftLink, setDraftLink] = useState<NamedLink>();
  const [opticalTarget, setOpticalTarget] = useState<EndpointRef>();
  const [dcScope, setDcScope] = useState<InstancePath>();
  const [leftTab, setLeftTab] = useState<SideTab | undefined>(() =>
    window.matchMedia('(max-width: 48rem)').matches ? undefined : 'structure');
  const [propertiesOpen, setPropertiesOpen] = useState(() => !window.matchMedia('(max-width: 48rem)').matches);
  const [expandedHierarchy, setExpandedHierarchy] = useState<ReadonlySet<string>>(new Set(['[]']));
  const [expandedCanvas, setExpandedCanvas] = useState<ReadonlySet<string>>(new Set());
  const [presentation, setPresentation] = useState<Presentation>();
  const [restoredView, setRestoredView] = useState<{ scope: string; view: CanvasView }>();
  const currentScope = hierarchyKey(selection.modulePath);
  const [placingModule, setPlacingModule] = useState(false);
  const [toolsHost, setToolsHost] = useState<HTMLDivElement | null>(null);
  const [viewHost, setViewHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => { setPlacingModule(false); }, [currentScope, topologyActive, projectSession]);
  useEffect(() => {
    if (restoredView && restoredView.scope !== currentScope) setRestoredView(undefined);
  }, [currentScope, restoredView]);
  const [linkInputs, setLinkInputs] = useState<ReadonlyMap<string, LinkTrial>>(new Map());
  const [localOptical, setLocalOptical] = useState<LocalOpticalSettings>({ sources: [] });
  const activeOccurrence = store.resolveInstance(selection.modulePath);
  const active = activeOccurrence?.definition;
  const selected = selection.instancePath && store.resolveInstance(selection.instancePath);
  const selectedPaths = selection.instancePaths ?? (selection.instancePath ? [selection.instancePath] : []);
  const properties = selection.instancePaths ? undefined : selected || activeOccurrence;
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
      for (const path of selection.instancePaths ?? (selection.instancePath ? [selection.instancePath] : [])) {
        for (let depth = 0; depth < path.length; depth++) next.add(hierarchyKey(path.slice(0, depth)));
      }
      return next.size === current.size ? current : next;
    });
  }, [selection.modulePath, selection.instancePath, selection.instancePaths]);

  function toggleFullPage(view: CanvasView) {
    closeWorkbenchMenu();
    if (!presentation) {
      setRestoredView(undefined);
      setPresentation({
        view, scope: selection.modulePath, selected: selectedPaths, leftTab, propertiesOpen, dock,
        collapsed, enlarged, expandedCanvas, expandedHierarchy,
      });
      return;
    }

    setLeftTab(presentation.leftTab);
    setPropertiesOpen(presentation.propertiesOpen);
    setDock(presentation.dock);
    setCollapsed(presentation.collapsed);
    setEnlarged(presentation.enlarged);
    setExpandedCanvas(presentation.expandedCanvas);
    setExpandedHierarchy(presentation.expandedHierarchy);
    store.selectModule(presentation.scope);
    store.selectInstances(presentation.selected);
    setRestoredView({ scope: hierarchyKey(presentation.scope), view: presentation.view });
    setPresentation(undefined);
  }

  function toggleBranch(path: InstancePath) {
    setExpandedHierarchy(current => {
      const next = new Set(current);
      const key = hierarchyKey(path);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectObjects(paths: readonly InstancePath[]) {
    store.selectInstances(paths);
  }

  function selectObject(path: InstancePath, extend: boolean) {
    if (!extend || !path.length) {
      selectObjects([path]);
      return;
    }
    const current = store.getSnapshot().selection;
    const paths = (current.instancePaths ?? (current.instancePath ? [current.instancePath] : [])).filter(item => item.length);
    const key = hierarchyKey(path);
    selectObjects(paths.some(item => hierarchyKey(item) === key)
      ? paths.filter(item => hierarchyKey(item) !== key) : [...paths, path]);
  }

  function selectTreeObject(path: InstancePath, extend: boolean) {
    if (inHierarchy(selection.modulePath, path)) {
      setExpandedCanvas(previous => {
        const next = new Set(previous);
        for (let depth = selection.modulePath.length + 1; depth < path.length; depth++) next.add(hierarchyKey(path.slice(0, depth)));
        return next.size === previous.size ? previous : next;
      });
    }
    selectObject(path, extend);
    openPage('canvas');
  }

  function revealStructureChange(instancePaths: readonly InstancePath[], remap: (path: InstancePath) => InstancePath | undefined, centerCanvas = true) {
    const instancePath = instancePaths[0];
    function remapExpansion(previous: ReadonlySet<string>) {
      const next = new Set<string>();
      for (const key of previous) {
        const path = JSON.parse(key) as InstancePath;
        const mapped = remap(path);
        if (mapped) next.add(hierarchyKey(mapped));
      }
      for (let depth = 0; depth < instancePath.length; depth++) next.add(hierarchyKey(instancePath.slice(0, depth)));
      return next;
    }
    setExpandedCanvas(remapExpansion);
    setExpandedHierarchy(remapExpansion);
    if (!inHierarchy(store.getSnapshot().selection.modulePath, instancePath)) store.selectModule(instancePath.slice(0, -1));
    selectObjects(instancePaths);
    setFocusMoved({ path: instancePath, centerCanvas });
  }

  function moveAcrossLevels(base: Project, plan: ApprovedMove, layout?: ReparentLayout, centerCanvas = true) {
    if (store.getSnapshot().project !== base) return '工程已变化，请重新拖动或选择对象。';
    const result = store.commit(() => {
      if (!layout) return plan.project;
      const placed = moveTopologyNodes(plan.project, layout.placements);
      return layout.frame ? resizeTopologyFrame(placed, layout.frame) : placed;
    });
    if (!result.ok) return result.message;
    revealStructureChange(plan.instancePaths, path => {
      const moved = plan.affected.find(item => inHierarchy(item.from, path));
      return moved ? [...moved.to, ...path.slice(moved.from.length)] : path;
    }, centerCanvas);
    store.setView('topology');
    openPage('canvas');
  }

  function copyModuleTo(copiedProject: Project, source: InstancePath, destination: InstancePath, position?: XYPosition) {
    const id = crypto.randomUUID();
    const path = [...destination, id];
    const snapshot = store.getSnapshot();
    const owner = store.resolveInstance(destination);
    const result = store.commit(draft => {
      const next = pasteModule(draft, copiedProject, source, destination, id, () => crypto.randomUUID());
      return position ? moveTopologyNodes(next, [{ instancePath: path, ...position }]) : next;
    });
    if (!result.ok) {
      setCopyNotice('');
      setError(result.message);
      return;
    }
    setError('');
    const scope = snapshot.selection.modulePath;
    const visible = snapshot.selection.view === 'topology' && inHierarchy(scope, destination)
      && destination.slice(scope.length).every((_, index) =>
        expandedCanvas.has(hierarchyKey(destination.slice(0, scope.length + index + 1))));
    if (visible) store.selectInstance(path);
    const [location] = structureLocations(linkOptions.graph.instances, [destination]);
    const shared = owner ? structureScope(linkOptions.graph.instances, owner.definition.id) : [];
    const copyName = store.resolveInstance(path)?.instance?.name;
    setCopyNotice(`已在「${location}」添加「${copyName}」。${shared.length ? `共享定义同时更新：${shared.join('、')}。` : ''}`);
  }

  function copySelectedModule() {
    const { project, selection } = store.getSnapshot();
    const path = selection.instancePath;
    const source = path?.length ? store.resolveInstance(path) : undefined;
    if (!path || !source?.instance || source.definition.kind !== 'module') return false;
    moduleClipboard.current = { project, path, ports: source.definition.ports };
    setCopyNotice(`已复制「${source.instance.name}」。可在目标模块视图按 Ctrl+V 粘贴。`);
    return true;
  }

  function pasteSelectedModule(placement: (ports: readonly PortDefinition[]) => XYPosition | undefined) {
    const copied = moduleClipboard.current;
    if (!copied) return false;
    copyModuleTo(copied.project, copied.path, store.getSnapshot().selection.modulePath, placement(copied.ports));
    return true;
  }

  function requestMoveUp(source: InstancePath) {
    const destination = source.slice(0, -2);
    const owner = store.resolveInstance(destination);
    const plan = planInstanceMove(project, source, destination);
    setMoveUp({ base: project, plan, destination: owner?.instance?.name ?? owner?.definition.name ?? '上一级模块' });
  }

  function requestDissolve(path: InstancePath) {
    const target = store.resolveInstance(path.slice(0, -1));
    setDissolve({ base: project, plan: planDissolveModule(project, path),
      destination: target?.instance?.name ?? target?.definition.name ?? '上一级模块' });
  }

  function confirmDissolve() {
    if (!dissolve?.plan.ok) return;
    const plan = dissolve.plan;
    if (store.getSnapshot().project !== dissolve.base) {
      setDissolve({ ...dissolve, error: '工程已变化，请关闭预览后重新解散。' });
      return;
    }
    const result = store.commit(() => plan.project);
    if (!result.ok) {
      setDissolve({ ...dissolve, error: result.message });
      return;
    }
    revealStructureChange([plan.children[0] ?? plan.parentPath], path => {
      const removed = plan.affected.find(prefix => inHierarchy(prefix, path));
      if (!removed) return path;
      if (removed.length < path.length) return [...removed.slice(0, -1), ...path.slice(removed.length)];
    });
    openPage('canvas');
    setDissolve(undefined);
  }

  function enterModule(path: InstancePath) {
    setCopyNotice('');
    store.selectModule(path);
    store.selectInstance(undefined);
    openPage('canvas');
  }

  function replaceProject(candidate: Project) {
    const result = store.replaceProject(candidate);
    setError(result.ok ? '' : result.message);
    if (result.ok) {
      moduleClipboard.current = undefined;
      setCopyNotice('');
      setSavedProject(store.getSnapshot().project);
      setDock(undefined);
      setDraftLink(undefined);
      setOpticalTarget(undefined);
      setDcScope(undefined);
      importAttempt.current++;
      topologyLocation.current = undefined;
      setProjectSession(session => session + 1);
      setPresentation(undefined);
      setRestoredView(undefined);
      setPortTarget(undefined);
      setNewPort(undefined);
      setFocusMoved(undefined);
      setMoveUp(undefined);
      setDissolve(undefined);
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
    if (store.resolveInstance(path)?.definition.kind === 'module') enterModule(path);
    else {
      enterModule(path.slice(0, -1));
      store.selectInstance(path);
    }
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
    <div className="v1-workbench" data-full-page={!!presentation}>
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
        </nav>
        <div className="v1-project-heading">
          <button className="v1-project-name" type="button" onClick={() => openPage('project')}
            title={project.name}>{project.name}</button>
          <span className="v1-project-status" role="status" data-modified={modified}>{modified ? '未保存' : '无未保存修改'}</span>
        </div>
        <span className="divider" />
        <div className="actions">
          <button type="button" aria-label="撤销" title="撤销" disabled={!canUndo} onClick={() => { store.undo(); setError(''); }}>↶</button>
          <button type="button" aria-label="重做" title="重做" disabled={!canRedo} onClick={() => { store.redo(); setError(''); }}>↷</button>
        </div>
        <button className="v1-new-module" type="button" disabled={!topologyActive}
          aria-pressed={placingModule && topologyActive} onClick={() => setPlacingModule(active => !active)}>
          {placingModule && topologyActive ? '取消放置' : '＋ 新建模块'}
        </button>
        <div className="view-switch" role="group" aria-label="视图选择">
          <button type="button" aria-pressed={page === 'canvas' && selection.view === 'topology'} onClick={showTopology}>框图</button>
          <button type="button" aria-pressed={page === 'canvas' && selection.view === 'physical'}
            onClick={() => {
              if (selection.view === 'topology') topologyLocation.current = selection;
              store.setView('physical');
              openPage('canvas');
            }}>机箱布局</button>
        </div>
        <nav className="v1-main-menu v1-view-menus" aria-label="计算与视图菜单">
          <details name="workbench-menu" data-workbench-popup><summary>计算</summary>
            <div className="v1-menu-items">
              <button type="button" onClick={showLinks}>查看链路预算</button>
              <button type="button" onClick={() => { setOpticalTarget(undefined); openBudget('optical'); }}>局部光功率</button>
              <button type="button" onClick={() => showDc()}>直流供电预算</button>
              <button type="button" onClick={() => openPage('profiles')}>工程标定方案</button>
            </div>
          </details>
          <details name="workbench-menu" data-workbench-popup><summary>视图</summary>
            <div className="v1-menu-items v1-view-items">
              <button type="button" aria-pressed={leftTab === 'structure'} onClick={() => setLeftTab(tab => tab === 'structure' ? undefined : 'structure')}>结构</button>
              <button type="button" aria-pressed={leftTab === 'library'} onClick={() => setLeftTab(tab => tab === 'library' ? undefined : 'library')}>器件库</button>
              <button type="button" aria-pressed={propertiesOpen} onClick={() => setPropertiesOpen(open => !open)}>属性</button>
              <div ref={setViewHost} className="v1-view-canvas-settings" />
            </div>
          </details>
        </nav>
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
            <HierarchyTree key={projectSession} project={project} focusMoved={focusMoved?.path} move={moveAcrossLevels}
              instances={linkOptions.graph.instances} modulePath={selection.modulePath}
              selected={selectedPaths} expanded={expandedHierarchy} toggle={toggleBranch} select={selectTreeObject}
              enter={enterModule} navigatePort={navigatePort} />
          </div>
          <div id="workbench-library" className="v1-side-scroll" hidden={leftTab !== 'library'}>
            {active?.kind === 'module' && <LibraryPanel key={projectSession} store={store} state={state} module={active} />}
          </div>
        </aside>
        <main className="v1-workbench-main" data-budget={dock ? collapsed ? 'collapsed' : enlarged ? 'enlarged' : 'open' : undefined}>
          <div className="v1-canvas-page" inert={page !== 'canvas' || selection.view !== 'topology'}
            aria-hidden={page !== 'canvas' || selection.view !== 'topology'}>
            {active?.kind === 'module' &&
              <TopologyEditor key={JSON.stringify(['topology', projectSession, selection.modulePath])}
                store={store} state={state} module={active} pathResult={pathResult} graph={linkOptions.graph} rename={renameSelection}
                expanded={expandedCanvas} setExpanded={setExpandedCanvas} budgetHighlight={budgetHighlight}
                onPortBudget={selectBudgetPort} onDcBudget={showDc} onAddPort={setPortTarget} newPort={newPort}
                onSelectObject={selectObject} onSelectObjects={selectObjects}
                copyModule={copySelectedModule} pasteModule={pasteSelectedModule} copyNotice={copyNotice}
                fullPage={!!presentation} toggleFullPage={toggleFullPage}
                restoreView={restoredView?.scope === currentScope ? restoredView.view : undefined}
                focusMoved={focusMoved?.centerCanvas ? focusMoved.path : undefined}
                moveAcrossLevels={(base, plan, layout) => moveAcrossLevels(base, plan, layout, false)}
                placingModule={topologyActive && placingModule} setPlacingModule={setPlacingModule}
                toolsHost={toolsHost} viewHost={viewHost} topologyActive={topologyActive} />}
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
          <div id="workbench-properties" className="v1-right-content" hidden={!propertiesOpen}>
            <div className="v1-side-scroll v1-object-properties">
              {selection.instancePaths && !topologyActive && <p className="panel" role="status">已选中 {selection.instancePaths.length} 个对象。选中单个对象可编辑属性。</p>}
              {properties && <PropertiesPanel key={JSON.stringify([projectSession, properties.instancePath])}
                store={store} occurrence={properties} occurrences={linkOptions.graph.instances} jumpToParameter={jumpToParameter} onAddPort={setPortTarget}
                onCopyModule={path => copyModuleTo(store.getSnapshot().project, path, path.slice(0, -1))}
                onAddInside={topologyActive && selected?.instance && selected.definition.kind === 'module'
                  ? path => { enterModule(path); setLeftTab('library'); } : undefined}
                onDcBudget={topologyActive && properties.definition.kind === 'module' && properties.definition.physicalEnclosure ? showDc : undefined}
                onMoveUp={selection.view === 'topology' && selected && selected.instancePath.length > 1 ? requestMoveUp : undefined}
                onDissolve={selection.view === 'topology' && selected?.instance && selected.definition.kind === 'module' ? requestDissolve : undefined} />}
            </div>
            <div className="v1-scope-tools" ref={setToolsHost} />
          </div>
        </aside>
      </div>
      {dissolve && <dialog className="v1-topology-dialog" aria-labelledby="dissolve-title"
        ref={dialog => { if (dialog && !dialog.open) dialog.showModal(); }} onCancel={() => setDissolve(undefined)}>
        <h3 id="dissolve-title">解散模块（保留内部对象）</h3>
        {dissolve.plan.ok ? <>
          <p>将 {dissolve.plan.children.length} 个直接子对象移到「{dissolve.destination}」，移除原容器。</p>
          <p>调整 {dissolve.plan.adjustedPorts.length} 个边界端口、{dissolve.plan.outsideWires} 条上层连接和 {dissolve.plan.outsideCores} 条上层纤芯，
            提升 {dissolve.plan.insideWires} 条内部连接和 {dissolve.plan.insideBundles} 个内部线束。</p>
          {dissolve.plan.affected.length > 1 && <p>共享结构影响范围：{
            structureLocations(linkOptions.graph.instances, dissolve.plan.affected).join('、')
          }</p>}
        </> : <p className="error" role="alert">{dissolve.plan.message}</p>}
        {dissolve.error && <p className="error" role="alert">{dissolve.error}</p>}
        <div className="actions">
          {dissolve.plan.ok && <button type="button" className="primary" onClick={confirmDissolve}>确认解散</button>}
          <button type="button" onClick={() => setDissolve(undefined)}>取消</button>
        </div>
      </dialog>}
      {moveUp && <dialog className="v1-topology-dialog" aria-labelledby="move-up-title"
        ref={dialog => { if (dialog && !dialog.open) dialog.showModal(); }} onCancel={() => setMoveUp(undefined)}>
        <h3 id="move-up-title">移到上一级：{moveUp.destination}</h3>
        {moveUp.plan.ok && <p>{moveWiringSummary(moveUp.plan.wiring)}</p>}
        {moveUp.plan.ok && moveUp.plan.affected.length > 1 && <p>共享结构影响范围：{
          structureLocations(linkOptions.graph.instances, moveUp.plan.affected.map(item => item.from)).join('、')
        }</p>}
        {!moveUp.plan.ok && <p className="error" role="alert">{moveUp.plan.message}</p>}
        {moveUp.error && <p className="error" role="alert">{moveUp.error}</p>}
        <div className="actions">
          {moveUp.plan.ok && <button type="button" className="primary" onClick={() => {
            if (!moveUp.plan.ok) return;
            const error = moveAcrossLevels(moveUp.base, moveUp.plan);
            setMoveUp(error ? { ...moveUp, error } : undefined);
          }}>确认移动</button>}
          <button type="button" onClick={() => setMoveUp(undefined)}>取消</button>
        </div>
      </dialog>}
      {targetPortOwner && <AddPortDialog name={targetPortOwner.instance?.name ?? targetPortOwner.definition.name}
        locations={structureScope(linkOptions.graph.instances, targetPortOwner.definition.id)}
        add={addPort} close={() => setPortTarget(undefined)} />}
    </div>
  );
}
