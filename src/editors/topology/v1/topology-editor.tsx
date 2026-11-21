import { portDisplayName, portTypeLabels } from '../../../workbench/v1/labels';
import { structureScope } from '../../../workbench/v1/structure-scope';
import { useState } from 'react';
import type { PathResult } from '../../../engine/v1/path-resolver';
import type { SignalGraph } from '../../../engine/v1/signal-graph';
import { builtInDefinitions } from '../../../library/v1/built-in';
import { insertLibraryItem } from '../../../library/v1/insert-library-item';
import type { LibraryItem } from '../../../library/v1/insert-library-item';
import { removeTopologyInstance, removeWiring } from '../../../state/v1/remove-topology-object';
import type { LocalEndpointRef } from '../../../model/v1/topology';
import { groupModule } from '../../../state/v1/group-module';
import { connectBoundaryPort, exposeModulePort, renamePort } from '../../../state/v1/module-ports';
import type { WiringSelection } from '../../../state/v1/remove-topology-object';
import type { EndpointRef, InstancePath, ModuleDefinition, Project } from '../../../model/v1/types';
import type { ProjectStore, ProjectStoreSnapshot } from '../../../state/v1/project-store';
import { editModule, editModuleWiring, moveTopologyNode, resizeTopologyFrame } from '../../../state/v1/topology-edits';
import { PortActionsDialog } from './port-actions-dialog';
import { PortBindingDialog } from './port-binding-dialog';
import type { BindingPreview } from './port-binding-dialog';
import { PortDeletionDialog } from './port-deletion-dialog';
import type { BudgetHighlight } from './path-highlight';
import { TopologyCanvas } from './topology-canvas';
import { displayDepth, hierarchyKey, inHierarchy } from './hierarchy-view';
import { CableForm, ConnectionForm, MappingForm, TopologyTool, field } from './wiring-forms';
import type { LocalPort, UpdateWiring } from './wiring-forms';
import './topology.css';

export function TopologyEditor({ store, state, module, pathResult, graph, rename, expanded, setExpanded, budgetHighlight, onPortBudget, onDcBudget, onAddPort, newPort }: {
  store: ProjectStore; state: ProjectStoreSnapshot; module: ModuleDefinition; pathResult?: PathResult; graph: SignalGraph; rename: () => void;
  expanded: ReadonlySet<string>; setExpanded: (value: ReadonlySet<string>) => void;
  budgetHighlight?: BudgetHighlight;
  onPortBudget: (action: 'optical' | 'from' | 'to', ref: EndpointRef) => void;
  onDcBudget: (scope: InstancePath) => void;
  onAddPort: (path: InstancePath) => void;
  newPort?: EndpointRef;
}) {
  const { project, selection } = state;
  const scope = selection.modulePath;
  const moduleName = store.resolveInstance(scope)?.instance?.name ?? module.name;
  const [message, setMessage] = useState('');
  const [groupMode, setGroupMode] = useState(false);
  const [groupPaths, setGroupPaths] = useState<readonly InstancePath[]>([]);
  const [groupDialog, setGroupDialog] = useState(false);
  const maxDepth = displayDepth(graph.instances, scope);
  const visibleDepth = displayDepth(graph.instances, scope, expanded);
  const [preview, setPreview] = useState<{ definitionId: string; portId: string }>();
  const [portAction, setPortAction] = useState<{ path: InstancePath; portId: string }>();
  const [bindingPreview, setBindingPreview] = useState<BindingPreview>();
  const definitions = new Map([...project.moduleDefinitions, ...project.componentDefinitions].map(definition => [definition.id, definition]));
  const projectDefinitions = [...definitions.values()].filter(definition =>
    definition.id !== module.id && definition.id !== project.rootModuleDefinitionId);
  const availableTemplates = builtInDefinitions.filter(template => !definitions.has(template.id));
  const selectedItem = selection.instancePath && store.resolveInstance(selection.instancePath);
  const selected = selectedItem?.definition;
  const dcScope = selected?.kind === 'module' && selected.physicalEnclosure ? selection.instancePath
    : module.physicalEnclosure ? scope : undefined;
  const sharedLocations = structureScope(graph.instances, module.id);
  const ports: LocalPort[] = module.instances.flatMap(instance => {
    const name = store.resolveInstance([...scope, instance.id])?.instance?.name ?? instance.name;
    return definitions.get(instance.definitionId)!.ports.map(port => ({
      ref: { instanceId: instance.id, portId: port.id }, port, label: `${name} / ${portDisplayName(port, true)} · ${portTypeLabels[port.type]}`,
    }));
  });

  function commit(change: (draft: Project) => Project) {
    const result = store.commit(change);
    setMessage(result.ok ? '' : result.message);
    return result.ok;
  }

  function changeGroupSelection(paths: readonly InstancePath[], active = true) {
    setGroupMode(active);
    setGroupPaths(paths);
    store.selectInstance(undefined);
    setMessage('');
  }

  const groupScope = groupPaths[0]?.slice(0, -1);
  const groupOwner = groupScope && store.resolveInstance(groupScope);
  const groupLocations = groupOwner ? structureScope(graph.instances, groupOwner.definition.id) : [];
  function openGroupDialog() {
    if (!groupScope || groupPaths.some(path => hierarchyKey(path.slice(0, -1)) !== hierarchyKey(groupScope))) {
      setMessage('请选择同一直接父模块下的对象。');
      return;
    }
    setMessage('');
    setGroupDialog(true);
  }

  function add(item: LibraryItem, position?: { x: number; y: number }) {
    const id = crypto.randomUUID();
    if (!commit(draft => insertLibraryItem(draft, item, module.id, scope, id, position))) return false;
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

  function deleteSelection(path: InstancePath, instanceId?: string, wire?: WiringSelection) {
    const definition = store.resolveInstance(path)?.definition;
    if (definition?.kind !== 'module') return false;
    if (instanceId) return commit(draft => removeTopologyInstance(draft, definition.id, instanceId));
    if (wire?.kind === 'mapping') return requestBinding(path, wire.id);
    return !!wire && commit(draft => removeWiring(draft, definition.id, wire));
  }

  function applyExpansion(next: Set<string>) {
    setExpanded(next);
    const selected = selection.instancePath;
    if (!selected || !inHierarchy(scope, selected)) return;
    for (let length = scope.length + 1; length < selected.length; length++) {
      const ancestor = selected.slice(0, length);
      if (!next.has(hierarchyKey(ancestor))) {
        store.selectInstance(ancestor);
        break;
      }
    }
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
        <select name="port" required>{available.map(port => <option key={port.id} value={port.id}>{portDisplayName(port, true)}</option>)}</select>
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
    return <PortActionsDialog port={port} name={instance?.name ?? definition.name} exposure={exposure}
      locations={structureScope(graph.instances, definition.id)} error={message}
      budget={action => { setPortAction(undefined); onPortBudget(action, { instancePath: path, portId }); }}
      rename={name => {
        if (name === (port.name ?? '') || commit(draft => renamePort(draft, definition.id, portId, name))) setPortAction(undefined);
      }}
      disconnect={definition.kind === 'module' && definition.portMappings?.some(mapping => mapping.portId === portId) ? () => {
        setPortAction(undefined);
        requestBinding(path, portId);
      } : undefined}
      close={() => { setMessage(''); setPortAction(undefined); }} />;
  }

  return <section className="v1-topology" aria-label={`框图 · ${moduleName}`}>
    <div className="v1-hierarchy-workspace">
      <TopologyCanvas project={project} instances={graph.instances} modulePath={scope} selectedInstance={selection.instancePath}
        pathResult={pathResult} budgetHighlight={budgetHighlight} expanded={expanded} toggleModule={toggleModule}
        groupMode={groupMode} groupPaths={groupPaths} changeGroupSelection={changeGroupSelection}
        selectInstance={store.selectInstance} enterModule={store.selectModule}
        onAddPort={onAddPort} newPort={newPort}
        openPort={(path, portId) => { setMessage(''); setPortAction({ path, portId }); }}
        add={add} deleteSelection={deleteSelection} rename={rename} report={setMessage} undo={store.undo} redo={store.redo}
        move={(path, position, frame) => commit(draft => {
          const placed = moveTopologyNode(draft, path, position);
          return frame ? resizeTopologyFrame(placed, { modulePath: path.slice(0, -1), ...frame }) : placed;
        })}
        resize={(frame, adjustments) => commit(draft => {
          const placed = adjustments.reduce((current, { path, position }) => moveTopologyNode(current, path, position), draft);
          return resizeTopologyFrame(placed, { modulePath: scope, ...frame });
        })}
        connect={(path, connection) => editScope(path, current => ({
          ...current, connections: [...(current.connections ?? []), { ...connection, id: crypto.randomUUID() }],
        }))}
        mapPort={(path, mapping) => requestBinding(path, mapping.portId, mapping.target)} />
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
      <div className="v1-hierarchy-depth">
        <label htmlFor="topology-depth">批量展开深度</label>
        <button type="button" onClick={() => expandTo(1)}>收起全部</button>
        <input id="topology-depth" type="range" min={1} max={maxDepth} value={visibleDepth} disabled={maxDepth === 1}
          aria-orientation="vertical" aria-valuetext={`第 ${visibleDepth} 层，共 ${maxDepth} 层`}
          onChange={event => expandTo(Number(event.currentTarget.value))} />
        <button type="button" onClick={() => expandTo(maxDepth + 1)}>展开全部</button>
        <output htmlFor="topology-depth">{visibleDepth} / {maxDepth}</output>
      </div>
      {message && !preview && !portAction && !bindingPreview && !groupDialog && <p className="v1-topology-message error" role="alert">{message}</p>}
    </div>
    <div className="v1-topology-tools">
      <button type="button" aria-pressed={groupMode} title="在空白处拖动框选，或逐个点击对象"
        onClick={() => changeGroupSelection(groupMode || !selection.instancePath ? [] : [selection.instancePath], !groupMode)}>
        框选 / 多选
      </button>
      {groupMode && <>
        <button type="button" disabled={groupPaths.length < 2} onClick={openGroupDialog}>组成模块</button>
        <span className="v1-group-count" role="status">已选 {groupPaths.length} 个</span>
      </>}
      {dcScope && <button type="button" className="v1-dc-entry" onClick={() => onDcBudget(dcScope)}>查看供电/功耗</button>}
      {sharedLocations.length > 0 && <details data-workbench-popup>
        <summary>共享结构 · {sharedLocations.length} 处</summary>
        <div className="v1-topology-tool-list">
          <strong>结构改动会应用到以下位置</strong>
          <ul>{sharedLocations.map(location => <li key={location}>{location}</li>)}</ul>
        </div>
      </details>}
      <details className="v1-topology-toolgroup" data-workbench-popup>
        <summary>编辑工具</summary>
        <div className="v1-topology-tool-list">
      <TopologyTool title="添加器件或模块">
        <form onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const definitionId = field(data, 'definition');
          const name = field(data, 'name');
          if (!definitionId || !name) return;
          if (add({ source: definitions.has(definitionId) ? 'project' : 'template', id: definitionId, name })) form.reset();
        }}>
          <label>器件或模块<select name="definition" required>
            <option value="">请选择</option>
            {!!projectDefinitions.length && <optgroup label="工程定义">
              {projectDefinitions.map(definition =>
                <option key={definition.id} value={definition.id}>{definition.name} ({definition.id})</option>)}
            </optgroup>}
            {!!availableTemplates.length && <optgroup label="内置模板">
              {availableTemplates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
            </optgroup>}
          </select></label>
          <label>名称<input name="name" required /></label>
          <button type="submit">添加到框图</button>
        </form>
        <form onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const name = field(data, 'name');
          if (!name) return;
          const id = crypto.randomUUID();
          const enclosure: ModuleDefinition = {
            kind: 'module', id, name, ports: [], instances: [],
            physicalEnclosure: { widthMm: Number(field(data, 'width')), depthMm: Number(field(data, 'depth')), heightMm: Number(field(data, 'height')) },
          };
          if (commit(draft => {
            const updated = editModule(draft, module.id, current => ({
              ...current, instances: [...current.instances, { id, name, definitionId: id }],
            }));
            return { ...updated, moduleDefinitions: [...updated.moduleDefinitions, enclosure] };
          })) {
            form.reset();
            store.selectInstance([...scope, id]);
          }
        }}>
          <p>新建发射或接收机箱时，直接填写机箱名称和尺寸。</p>
          <label>机箱名称<input name="name" required /></label>
          <div className="v1-topology-dimensions">
            <label>宽 (mm)<input name="width" type="number" min="0.001" step="any" defaultValue={440} required /></label>
            <label>深 (mm)<input name="depth" type="number" min="0.001" step="any" defaultValue={350} required /></label>
            <label>高 (mm)<input name="height" type="number" min="0.001" step="any" defaultValue={44.45} required /></label>
          </div>
          <button type="submit">新建空机箱</button>
        </form>
      </TopologyTool>
      <TopologyTool title="对外端口">
        <button type="button" onClick={() => onAddPort(selection.instancePath ?? scope)}>
          ＋ 添加端口 · {selectedItem?.instance?.name ?? selectedItem?.definition.name ?? module.name}
        </button>
        {portRemoval(module.id, '删除对外端口')}
        {selected && selected.id !== module.id && portRemoval(selected.id, `删除所选实例的定义端口 · ${selected.name}`)}
      </TopologyTool>
      <ConnectionForm module={module} ports={ports} update={updateWiring} />
      <MappingForm module={module} ports={ports} connect={(portId, target) => requestBinding(scope, portId, target)} />
      <CableForm module={module} ports={ports} update={updateWiring} />
        </div>
      </details>
    </div>
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
          changeGroupSelection([], false);
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
