import { setWireRoute } from '../../../state/v1/wire-routes';
import { createPortal } from 'react-dom';
import { editablePortName, portDisplayName, portTypeLabels } from '../../../workbench/v1/labels';
import { createPathNames, structureScope } from '../../../workbench/v1/structure-scope';
import { useState } from 'react';
import type { PathResult } from '../../../engine/v1/path-resolver';
import type { SignalGraph } from '../../../engine/v1/signal-graph';
import type { LibraryItem } from '../../../library/v1/insert-library-item';
import { removeTopologyInstances, removeWiring } from '../../../state/v1/remove-topology-object';
import type { LocalEndpointRef } from '../../../model/v1/topology';
import type { ApprovedMove, ReparentLayout } from './reparent-drop';
import { groupModule } from '../../../state/v1/group-module';
import { connectBoundaryPort, exposeModulePort, renamePort } from '../../../state/v1/module-ports';
import type { WiringSelection } from '../../../state/v1/remove-topology-object';
import type { EndpointRef, InstancePath, ModuleDefinition, Project } from '../../../model/v1/types';
import type { ProjectStore, ProjectStoreSnapshot } from '../../../state/v1/project-store';
import { editModule, editModuleWiring, moveTopologyNodes, resizeTopologyFrame } from '../../../state/v1/topology-edits';
import { PortActionsDialog } from './port-actions-dialog';
import { PortBindingDialog } from './port-binding-dialog';
import type { BindingPreview } from './port-binding-dialog';
import { PortDeletionDialog } from './port-deletion-dialog';
import type { BudgetHighlight } from './path-highlight';
import { insertCanvasItem } from './topology-layout-edits';
import type { CanvasView } from './canvas-controls';
import { TopologyCanvas } from './topology-canvas';
import { displayDepth, hierarchyKey, inHierarchy, sharedParent } from './hierarchy-view';
import { CableForm, ConnectionForm, MappingForm, TopologyTool, field } from './wiring-forms';
import type { LocalPort, UpdateWiring } from './wiring-forms';
import './topology.css';

import type { LibraryConfig } from '../../../library/v1/user-library';

export function TopologyEditor({ centerPlacement, linkControls, library, store, state, module, pathResult, graph, rename, expanded, setExpanded, budgetHighlight, onPortBudget, onDcBudget, onAddPort, newPort, onSelectObject, onSelectObjects, moveAcrossLevels, focusMoved, copyModule, pasteModule, copyNotice, fullPage, toggleFullPage, restoreView, placingModule, setPlacingModule, toolsHost, viewHost, topologyActive }: {
  linkControls: import('react').ReactNode;
  library: LibraryConfig;
  store: ProjectStore; state: ProjectStoreSnapshot; module: ModuleDefinition; pathResult?: PathResult; graph: SignalGraph; rename: () => void;
  expanded: ReadonlySet<string>; setExpanded: (value: ReadonlySet<string>) => void;
  budgetHighlight?: BudgetHighlight;
  onPortBudget: (action: 'optical' | 'from' | 'to', ref: EndpointRef) => void;
  onDcBudget: (scope: InstancePath) => void;
  onAddPort: (path: InstancePath) => void;
  onSelectObject: (path: InstancePath, extend: boolean) => void;
  onSelectObjects: (paths: readonly InstancePath[]) => void;
  moveAcrossLevels: (base: Project, plan: ApprovedMove, layout?: ReparentLayout) => string | undefined;
  centerPlacement: Parameters<typeof TopologyCanvas>[0]['centerPlacement'];
  copyModule: Parameters<typeof TopologyCanvas>[0]['copyModule'];
  pasteModule: Parameters<typeof TopologyCanvas>[0]['pasteModule'];
  copyNotice: string;
  fullPage: boolean;
  toggleFullPage: (view: CanvasView) => void;
  restoreView?: CanvasView;
  placingModule: boolean;
  setPlacingModule: (active: boolean) => void;
  toolsHost: HTMLDivElement | null;
  viewHost: HTMLDivElement | null;
  topologyActive: boolean;
  focusMoved?: InstancePath;
  newPort?: EndpointRef;
}) {
  const { project, selection } = state;
  const scope = selection.modulePath;
  const scopeOccurrence = store.resolveInstance(scope);
  const moduleName = scopeOccurrence?.instance?.name ?? module.name;
  const [message, setMessage] = useState('');
  const selectedPaths = selection.instancePaths ?? (selection.instancePath ? [selection.instancePath] : []);
  const [groupDialog, setGroupDialog] = useState(false);
  const maxDepth = displayDepth(graph.instances, scope);
  const visibleDepth = displayDepth(graph.instances, scope, expanded);
  const [preview, setPreview] = useState<{ definitionId: string; portId: string }>();
  const [portAction, setPortAction] = useState<{ path: InstancePath; portId: string }>();
  const [bindingPreview, setBindingPreview] = useState<BindingPreview>();
  const definitions = new Map([...project.moduleDefinitions, ...project.componentDefinitions].map(definition => [definition.id, definition]));
  const selected = selection.instancePath && store.resolveInstance(selection.instancePath)?.definition;
  const activeDcShortcut = module.physicalEnclosure && (selection.instancePaths
    || (selected && (selected.kind !== 'module' || !selected.physicalEnclosure)));
  const sharedLocations = structureScope(graph.instances, module.id);
  const depth = { value: visibleDepth, max: maxDepth, set: expandTo };
  const { showName } = createPathNames(graph.instances);
  const ports: LocalPort[] = module.instances.flatMap(instance => {
    const path = [...scope, instance.id];
    const name = showName(path);
    const occurrence = store.resolveInstance(path);
    const ports = definitions.get(instance.definitionId)!.ports;
    return ports.map(port => ({
      ref: { instanceId: instance.id, portId: port.id }, port, label: `${name} / ${portDisplayName(port, true, ports, occurrence)} · ${portTypeLabels[port.type]}`,
    }));
  });

  function commit(change: (draft: Project) => Project) {
    const result = store.commit(change);
    setMessage(result.ok ? '' : result.message);
    return result.ok;
  }

  const groupPaths = selection.instancePaths ?? [];
  const commonParent = sharedParent(groupPaths);
  const groupScope = commonParent && inHierarchy(scope, commonParent) ? commonParent : undefined;
  const groupOwner = groupScope && store.resolveInstance(groupScope);
  const groupLocations = groupOwner ? structureScope(graph.instances, groupOwner.definition.id) : [];
  function openGroupDialog() {
    setMessage('');
    setGroupDialog(true);
  }

  function add(item: LibraryItem, position?: { x: number; y: number }) {
    const id = crypto.randomUUID();
    if (!commit(draft => insertCanvasItem(draft, item, module.id, scope, id, position, library))) return false;
    setPlacingModule(false);
    store.selectInstance([...scope, id]);
    return true;
  }

  function requestBinding(path: InstancePath, portId: string, target?: LocalEndpointRef) {
    const definition = store.resolveInstance(path)?.definition;
    if (definition?.kind !== 'module') return false;
    const existing = definition.portMappings?.find(mapping => mapping.portId === portId);
    if (!existing) return !!target && commit(draft => connectBoundaryPort(draft, definition.id, portId, target));
    if (target?.instanceId === existing.target.instanceId && target.portId === existing.target.portId) return false;
    setMessage('');
    setBindingPreview({ scope: path, module: definition, portId, target });
    return true;
  }

  function deleteInstances(paths: readonly InstancePath[], preserve: (project: Project, parentIds: ReadonlySet<string>) => Project) {
    commit(draft => {
      const removed = removeTopologyInstances(draft, paths);
      return preserve(removed.project, removed.affected);
    });
  }

  function deleteWiring(path: InstancePath, wire: WiringSelection) {
    if (wire.kind === 'mapping') return requestBinding(path, wire.id);
    const definition = store.resolveInstance(path)?.definition;
    return definition?.kind === 'module' && commit(draft => removeWiring(draft, definition.id, wire));
  }

  function applyExpansion(next: Set<string>) {
    setExpanded(next);
    const visiblePaths = selectedPaths.map(path => {
      if (!inHierarchy(scope, path)) return path;
      for (let length = scope.length + 1; length < path.length; length++) {
        const ancestor = path.slice(0, length);
        if (!next.has(hierarchyKey(ancestor))) return ancestor;
      }
      return path;
    });
    if (visiblePaths.some((path, index) => path !== selectedPaths[index])) store.selectInstances(visiblePaths);
  }

  function toggleModule(path: InstancePath) {
    const key = hierarchyKey(path);
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    applyExpansion(next);
  }

  function expandTo(depth: number) {
    const next = new Set(expanded);
    for (const { instancePath, definition } of graph.instances) {
      if (definition.kind !== 'module' || instancePath.length <= scope.length || !inHierarchy(scope, instancePath)) continue;
      const key = hierarchyKey(instancePath);
      if (instancePath.length - scope.length < depth) next.add(key);
      else next.delete(key);
    }
    applyExpansion(next);
  }

  function editScope(path: InstancePath, change: Parameters<UpdateWiring>[0]) {
    const definition = store.resolveInstance(path)?.definition;
    return definition?.kind === 'module' && commit(draft => editModule(draft, definition.id, change));
  }

  const updateWiring: UpdateWiring = change => commit(draft => editModuleWiring(draft, module.id, change));

  function portRemoval(definitionId: string, heading: string) {
    const available = definitions.get(definitionId)?.ports;
    if (!available?.length) return null;
    return <form key={definitionId} onSubmit={event => {
      event.preventDefault();
      setMessage('');
      setPreview({ definitionId, portId: String(new FormData(event.currentTarget).get('port')) });
    }}>
      <label>{heading}
        <select name="port" required>{available.map(port => <option key={port.id} value={port.id}>{portDisplayName(port, true, available, scopeOccurrence)}</option>)}</select>
      </label>
      <button type="submit" aria-label={`预览删除 · ${heading}`}>预览删除</button>
    </form>;
  }

  function renderPortActions({ path, portId }: NonNullable<typeof portAction>) {
    const item = store.resolveInstance(path);
    const port = item?.definition.ports.find(port => port.id === portId);
    if (!item || !port) return null;
    const { definition, instance } = item;
    const parentPath = path.slice(0, -1);
    const parent = path.length > scope.length ? store.resolveInstance(parentPath) : undefined;
    const exposure = parent?.definition.kind === 'module' && instance ? {
      moduleName: parent.instance?.name ?? parent.definition.name,
      locations: structureScope(graph.instances, parent.definition.id),
      create: (name: string) => {
        if (commit(draft => exposeModulePort(draft, parentPath, { instanceId: instance.id, portId }, name))) setPortAction(undefined);
      },
    } : undefined;
    return <PortActionsDialog port={port} label={portDisplayName(port, false, definition.ports, item)} name={instance?.name ?? definition.name} exposure={exposure}
      locations={structureScope(graph.instances, definition.id)} error={message}
      budget={action => { setPortAction(undefined); onPortBudget(action, { instancePath: path, portId }); }}
      rename={name => {
        if (name === editablePortName(port) || commit(draft => renamePort(draft, definition.id, portId, name))) setPortAction(undefined);
      }}
      disconnect={definition.kind === 'module' && definition.portMappings?.some(mapping => mapping.portId === portId) ? () => {
        setPortAction(undefined);
        requestBinding(path, portId);
      } : undefined}
      close={() => { setMessage(''); setPortAction(undefined); }} />;
  }

  return <section className="v1-topology" aria-label={`框图 · ${moduleName}`}>
    <div className="v1-hierarchy-workspace">
      <TopologyCanvas centerPlacement={centerPlacement} project={project} instances={graph.instances} modulePath={scope} selectedInstance={selection.instancePath}
        pathResult={pathResult} budgetHighlight={budgetHighlight} expanded={expanded} toggleModule={toggleModule}
        selectedPaths={selectedPaths} selectObject={onSelectObject} selectObjects={onSelectObjects}
        enterModule={store.selectModule} focusMoved={focusMoved}
        fullPage={fullPage} toggleFullPage={toggleFullPage} restoreView={restoreView}
        depth={depth} viewHost={viewHost} topologyActive={topologyActive}
        reparent={(base, plan, layout) => setMessage(moveAcrossLevels(base, plan, layout) ?? '')}
        onAddPort={onAddPort} newPort={newPort}
        openPort={(path, portId) => { setMessage(''); setPortAction({ path, portId }); }}
        add={add} placingModule={placingModule} cancelPlacement={() => { setPlacingModule(false); setMessage(''); }}
        deleteInstances={deleteInstances} deleteWiring={deleteWiring} rename={rename} copyModule={copyModule} pasteModule={pasteModule} report={setMessage} undo={store.undo} redo={store.redo}
        route={(scope, wire, point) => commit(draft => setWireRoute(draft, scope, wire, point))}
        move={(moves, frame) => commit(draft => {
          const placed = moveTopologyNodes(draft, moves);
          return frame ? resizeTopologyFrame(placed, frame) : placed;
        })}
        resize={(frame, adjustments) => commit(draft =>
          resizeTopologyFrame(moveTopologyNodes(draft, adjustments), frame))}
        saveExpansion={({ moves, frames }) => commit(draft =>
          frames.reduce(resizeTopologyFrame, moveTopologyNodes(draft, moves)))}
        connect={(path, connection) => editScope(path, current => ({
          ...current, connections: [...(current.connections ?? []), { ...connection, id: crypto.randomUUID() }],
        }))}
        mapPort={(path, mapping) => requestBinding(path, mapping.portId, mapping.target)} />
      <div className="v1-canvas-heading">
      <nav className="v1-topology-path" aria-label="模块路径">
        {Array.from({ length: scope.length + 1 }, (_, index) => {
          const path = scope.slice(0, index);
          const occurrence = store.resolveInstance(path);
          const name = occurrence?.instance?.name ?? occurrence?.definition.name;
          return index === scope.length
            ? <strong key={index} id="topology-title" aria-current="location">{name}</strong>
            : <span key={index}><button type="button" onClick={() => store.selectModule(path)}>{name}</button><span aria-hidden="true">›</span></span>;
        })}
      </nav>
      {linkControls}
      {placingModule && <p className="v1-placement-hint" role="status">单击画布放置到「{moduleName}」 · Esc 取消</p>}
      </div>
      {copyNotice && !message && <p className="v1-topology-message v1-module-copy-notice" role="status">{copyNotice}</p>}
      {message && !preview && !portAction && !bindingPreview && !groupDialog && <p className="v1-topology-message error" role="alert">{message}</p>}
    </div>
    {topologyActive && toolsHost && createPortal(<div className="v1-module-tools">
      {groupPaths.length > 1 && <section className="v1-multi-operations">
        <p className="v1-property-effective" role="status">已选中 {groupPaths.length} 个对象。</p>
        {groupScope ? <button type="button" onClick={openGroupDialog}>组成模块</button>
          : <p className="v1-property-effective">组成模块需要选择同一直接父模块下的对象。</p>}
      </section>}
      <details key={hierarchyKey(scope)} className="v1-current-module-tools">
        <summary>当前编辑模块 · {moduleName}</summary>
        {sharedLocations.length > 0 && <p className="v1-property-effective">
          「{moduleName}」的共享结构改动会应用到 {sharedLocations.join('、')}。
        </p>}

        {activeDcShortcut && <button type="button" onClick={() => onDcBudget(scope)}>查看供电/功耗 · {moduleName}</button>}
        <TopologyTool title="模块对外端口">
          <button type="button" onClick={() => onAddPort(scope)}>＋ 添加对外端口</button>
          {portRemoval(module.id, '删除对外端口')}
        </TopologyTool>
        <ConnectionForm module={module} ports={ports} update={updateWiring} />
        <MappingForm labelContext={scopeOccurrence} module={module} ports={ports} connect={(portId, target) => requestBinding(scope, portId, target)} />
        <CableForm module={module} ports={ports} update={updateWiring} />
      </details>
    </div>, toolsHost)}
    {groupDialog && groupScope && <dialog ref={dialog => { if (dialog && !dialog.open) dialog.showModal(); }}
      className="v1-topology-dialog" aria-labelledby="group-module-title" onCancel={() => { setGroupDialog(false); setMessage(''); }}>
      <h3 id="group-module-title">组成模块</h3>
      <p>将在「{groupOwner?.instance?.name ?? groupOwner?.definition.name}」中移动 {groupPaths.length} 个对象，并生成必要的对外端口。</p>
      {groupLocations.length > 0 && <p>共享结构会同时应用到 {groupLocations.join('、')}。</p>}
      <form onSubmit={event => {
        event.preventDefault();
        const name = field(new FormData(event.currentTarget), 'name');
        const id = crypto.randomUUID();
        if (commit(draft => groupModule(draft, groupPaths, name, id, crypto.randomUUID()))) {
          setGroupDialog(false);
          store.selectInstance([...groupScope, id]);
        }
      }}>
        <label>新模块名称 <input name="name" required autoFocus /></label>
        {message && <p className="error" role="alert">{message}</p>}
        <div className="actions">
          <button type="submit">创建模块</button>
          <button type="button" onClick={() => { setGroupDialog(false); setMessage(''); }}>取消</button>
        </div>
      </form>
    </dialog>}
    {portAction && renderPortActions(portAction)}
    {bindingPreview && <PortBindingDialog store={store} preview={bindingPreview}
      locations={structureScope(graph.instances, bindingPreview.module.id)} close={() => setBindingPreview(undefined)} />}
    {preview && <PortDeletionDialog store={store} {...preview} close={() => setPreview(undefined)} />}
  </section>;
}
