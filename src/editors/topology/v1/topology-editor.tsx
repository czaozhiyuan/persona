import { useEffect, useState } from 'react';
import type { PathResult } from '../../../engine/v1/path-resolver';
import type { SignalGraph } from '../../../engine/v1/signal-graph';
import type { InstancePath, ModuleDefinition, PortDirection, PortType, Project } from '../../../model/v1/types';
import type { ProjectStore, ProjectStoreSnapshot } from '../../../state/v1/project-store';
import { editModule, editModuleWiring, moveTopologyNode } from '../../../state/v1/topology-edits';
import { PortDeletionDialog } from './port-deletion-dialog';
import { projectPathHighlight } from './path-highlight';
import { TopologyCanvas } from './topology-canvas';
import { HierarchyCanvas } from './hierarchy-canvas';
import { HierarchyTree } from './hierarchy-tree';
import { displayDepth, hierarchyKey } from './hierarchy-view';
import { CableForm, ConnectionForm, MappingForm, field } from './wiring-forms';
import type { LocalPort, UpdateWiring } from './wiring-forms';
import './topology.css';

export function TopologyEditor({ store, state, module, pathResult, graph, expandedHierarchy, setExpandedHierarchy }: {
  store: ProjectStore; state: ProjectStoreSnapshot; module: ModuleDefinition; pathResult?: PathResult; graph: SignalGraph;
  expandedHierarchy: ReadonlySet<string>;
  setExpandedHierarchy: (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => void;
}) {
  const { project, selection } = state;
  const scope = selection.modulePath;
  const moduleName = store.resolveInstance(scope)?.instance?.name ?? module.name;
  const [message, setMessage] = useState('');
  const [requestedDepth, setRequestedDepth] = useState(1);
  const maxDepth = displayDepth(graph.instances, scope);
  const depth = Math.min(requestedDepth, maxDepth);
  const [preview, setPreview] = useState<{ definitionId: string; portId: string }>();
  const definitions = new Map([...project.moduleDefinitions, ...project.componentDefinitions].map(definition => [definition.id, definition]));
  const selected = selection.instancePath && store.resolveInstance(selection.instancePath)?.definition;
  const ports: LocalPort[] = module.instances.flatMap(instance => definitions.get(instance.definitionId)!.ports.map(port => ({
    ref: { instanceId: instance.id, portId: port.id }, port, label: `${instance.name} / ${port.id} · ${port.type}`,
  })));

  useEffect(() => {
    setExpandedHierarchy(current => {
      const next = new Set(current);
      for (let i = 0; i <= scope.length; i++) next.add(hierarchyKey(scope.slice(0, i)));
      return next.size === current.size ? current : next;
    });
  }, [scope, setExpandedHierarchy]);

  function navigate(path: InstancePath, isModule: boolean) {
    if (isModule) store.selectModule(path);
    else {
      store.selectModule(path.slice(0, -1));
      store.selectInstance(path);
    }
  }

  function commit(change: (draft: Project) => Project) {
    const result = store.commit(change);
    setMessage(result.ok ? '' : result.message);
    return result.ok;
  }

  const updateModule: UpdateWiring = change => commit(draft => editModule(draft, module.id, change));
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
        <select name="port" required>{available.map(port => <option key={port.id} value={port.id}>{port.id}</option>)}</select>
      </label>
      <button type="submit" aria-label={`预览删除 · ${heading}`}>预览删除</button>
    </form>;
  }

  return <section className="panel v1-topology" aria-labelledby="topology-title">
    <h2 id="topology-title">逻辑拓扑 · {moduleName}</h2>
    <div className="v1-hierarchy-workspace">
      <HierarchyTree instances={graph.instances} modulePath={scope} selected={selection.instancePath}
        expanded={expandedHierarchy} navigate={navigate} toggle={path => {
          setExpandedHierarchy(current => {
            const next = new Set(current);
            const key = hierarchyKey(path);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          });
        }} />
      <div className="v1-hierarchy-graph">
    {depth === 1 ? <TopologyCanvas key={hierarchyKey(scope)} project={project} module={module} moduleName={moduleName} modulePath={scope} selectedInstance={selection.instancePath}
      highlight={projectPathHighlight(pathResult, scope)}
      selectInstance={store.selectInstance} enterModule={store.selectModule}
      move={(id, position) => commit(draft => moveTopologyNode(draft, [...scope, id], position))}
      connect={connection => updateModule(current => ({
        ...current, connections: [...(current.connections ?? []), { ...connection, id: crypto.randomUUID() }],
      }))}
      mapPort={mapping => updateModule(current => ({
        ...current, portMappings: [...(current.portMappings ?? []).filter(item => item.portId !== mapping.portId), mapping],
      }))} /> : <HierarchyCanvas key={JSON.stringify([scope, depth])} graph={graph} scope={scope} depth={depth} result={pathResult}
        selected={selection.instancePath} select={store.selectInstance} navigate={store.selectModule} />}
        {depth > 1 && <p className="v1-hierarchy-caption">多层总览 · 回到第 1 层可拖动节点和画布接线。</p>}
      </div>
      <div className="v1-hierarchy-depth">
        <label htmlFor="topology-depth">展开深度</label>
        <span>当前层</span>
        <input id="topology-depth" type="range" min={1} max={maxDepth} value={depth} disabled={maxDepth === 1}
          aria-orientation="vertical" aria-valuetext={`第 ${depth} 层，共 ${maxDepth} 层`}
          onChange={event => setRequestedDepth(Number(event.currentTarget.value))} />
        <span>全部</span>
        <output htmlFor="topology-depth">{depth} / {maxDepth}</output>
      </div>
    </div>
    {message && !preview && <p className="error" role="alert">{message}</p>}
    <div className="v1-topology-tools">
      <details>
        <summary>添加实例</summary>
        <form onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const definition = definitions.get(field(data, 'definition'));
          const name = field(data, 'name');
          if (!definition || !name) return;
          if (updateModule(current => ({ ...current, instances: [...current.instances, {
            id: crypto.randomUUID(), name, definitionId: definition.id,
            switchStateId: definition.kind === 'component' ? definition.switchStates?.[0]?.id : undefined,
          }] }))) form.reset();
        }}>
          <label>定义<select name="definition" required>
            <option value="">请选择</option>
            {[...definitions.values()].filter(definition => definition.id !== module.id).map(definition =>
              <option key={definition.id} value={definition.id}>{definition.name} ({definition.id})</option>)}
          </select></label>
          <label>实例名称<input name="name" required /></label>
          <button type="submit">添加实例</button>
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
          })) form.reset();
        }}>
          <label>机箱名称<input name="name" required /></label>
          <div className="v1-topology-dimensions">
            <label>宽 (mm)<input name="width" type="number" min="0.001" step="any" defaultValue={440} required /></label>
            <label>深 (mm)<input name="depth" type="number" min="0.001" step="any" defaultValue={350} required /></label>
            <label>高 (mm)<input name="height" type="number" min="0.001" step="any" defaultValue={44.45} required /></label>
          </div>
          <button type="submit">新建空机箱</button>
        </form>
      </details>
      <details>
        <summary>公开端口</summary>
        <form onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const id = field(data, 'id');
          if (updateModule(current => ({ ...current, ports: [...current.ports, {
            id, type: field(data, 'type') as PortType, direction: field(data, 'direction') as PortDirection,
          }] }))) form.reset();
        }}>
          <label>端口 ID<input name="id" required /></label>
          <label>端口类型<select name="type" defaultValue="OPTICAL">
            <option>OPTICAL</option><option>RF</option><option>DC_POWER</option><option>CONTROL</option>
          </select></label>
          <label>端口方向<select name="direction"><option value="in">输入</option><option value="out">输出</option></select></label>
          <button type="submit">声明公开端口</button>
        </form>
        {portRemoval(module.id, '删除公开端口')}
        {selected && selected.id !== module.id && portRemoval(selected.id, `删除所选实例的定义端口 · ${selected.name}`)}
      </details>
      <ConnectionForm module={module} ports={ports} update={updateWiring} />
      <MappingForm module={module} ports={ports} update={updateModule} />
      <CableForm module={module} ports={ports} update={updateWiring} />
    </div>
    {preview && <PortDeletionDialog store={store} {...preview} close={() => setPreview(undefined)} />}
  </section>;
}
