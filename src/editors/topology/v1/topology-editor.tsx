import { useState } from 'react';
import type { ModuleDefinition, PortDirection, PortType, Project } from '../../../model/v1/types';
import type { ProjectStore, ProjectStoreSnapshot } from '../../../state/v1/project-store';
import { editModule, editModuleWiring, moveTopologyNode } from '../../../state/v1/topology-edits';
import { PortDeletionDialog } from './port-deletion-dialog';
import { TopologyCanvas } from './topology-canvas';
import { CableForm, ConnectionForm, MappingForm, field } from './wiring-forms';
import type { LocalPort, UpdateWiring } from './wiring-forms';
import './topology.css';

export function TopologyEditor({ store, state, module }: { store: ProjectStore; state: ProjectStoreSnapshot; module: ModuleDefinition }) {
  const { project, selection } = state;
  const scope = selection.modulePath;
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<{ definitionId: string; portId: string }>();
  const definitions = new Map([...project.moduleDefinitions, ...project.componentDefinitions].map(definition => [definition.id, definition]));
  const selected = selection.instancePath && store.resolveInstance(selection.instancePath)?.definition;
  const ports: LocalPort[] = module.instances.flatMap(instance => definitions.get(instance.definitionId)!.ports.map(port => ({
    ref: { instanceId: instance.id, portId: port.id }, port, label: `${instance.name} / ${port.id} · ${port.type}`,
  })));

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
    <h2 id="topology-title">逻辑拓扑 · {store.resolveInstance(scope)?.instance?.name ?? module.name}</h2>
    <TopologyCanvas project={project} module={module} modulePath={scope} selectedInstance={selection.instancePath}
      selectInstance={store.selectInstance} enterModule={store.selectModule}
      move={(id, position) => commit(draft => moveTopologyNode(draft, [...scope, id], position))}
      connect={connection => updateModule(current => ({
        ...current, connections: [...(current.connections ?? []), { ...connection, id: crypto.randomUUID() }],
      }))}
      mapPort={mapping => updateModule(current => ({
        ...current, portMappings: [...(current.portMappings ?? []).filter(item => item.portId !== mapping.portId), mapping],
      }))} />
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
