import { canMapDirection, supportsDirection } from '../../model/v1/types';
import { withMappedVoltages, readChildParameters, type ResolvedInstance } from '../../engine/v1/hierarchy';
import { numberedNamesById, wireArrow } from '../../model/v1/display-names';
import { useState } from 'react';
import type { LibraryDefinition } from '../../library/v1/project-snapshots';
import type { ModuleDefinition } from '../../model/v1/types';
import type { LocalEndpointRef } from '../../model/v1/topology';
import { portDisplayName } from './labels';

export function TemplateModule({ occurrence, module, definitions, hidden, change }: {
  occurrence: ResolvedInstance; module: ModuleDefinition; definitions: LibraryDefinition[]; hidden: readonly string[]; change: (module: ModuleDefinition) => void;
}) {
  const labels = numberedNamesById(definitions);
  const available = definitions.filter(d => d.id !== module.id && !hidden.includes(d.id));
  const [choice, select] = useState('');
  const childDefinition = available.find(d => d.id === choice) ?? available[0];
  const children = module.instances.map(i => ({ i, d: definitions.find(d => d.id === i.definitionId) }));
  const byId = new Map(definitions.map(d => [d.id, d]));
  const ports = children.flatMap(({ i, d }) => {
    if (!d) return [];
    const effective = withMappedVoltages({ definition: d, instancePath: [i.id], instance: i,
      parameters: readChildParameters(d, i, module, occurrence.parameters, () => []) }, byId);
    return d.ports.map(p => ({ p, target: { instanceId: i.id, portId: p.id },
      label: i.name + ' · ' + portDisplayName(p, false, d.ports, effective) }));
  });
  const params = children.flatMap(({ i, d }) => (d?.parameters ?? []).map(p => ({
    p, target: { instanceId: i.id, parameterId: p.id }, label: i.name + ' · ' + p.name,
  })));
  const endpoint = (ref: LocalEndpointRef) => ports.find(o => o.target.instanceId === ref.instanceId && o.target.portId === ref.portId);
  return <>
    <fieldset><legend>模块子结构</legend>
      {module.instances.map(i => <div key={i.id}><label>子实例名称<input value={i.name}
        onChange={e => change({ ...module, instances: module.instances.map(child => child.id === i.id ? { ...child, name: e.target.value } : child) })} /></label>
        <button onClick={() => change({ ...module,
          instances: module.instances.filter(child => child.id !== i.id),
          portMappings: module.portMappings?.filter(m => m.target.instanceId !== i.id),
          parameterMappings: module.parameterMappings?.filter(m => m.target.instanceId !== i.id),
          connections: module.connections?.filter(c => c.from.instanceId !== i.id && c.to.instanceId !== i.id),
          cableBundles: module.cableBundles?.map(bundle => ({ ...bundle, cores: bundle.cores.map(core => ({ ...core,
            a: core.a.endpoint?.instanceId === i.id ? { pin: core.a.pin } : core.a,
            b: core.b.endpoint?.instanceId === i.id ? { pin: core.b.pin } : core.b,
          })) })),
        })}>移除子实例</button></div>)}
      <label>子模板<select value={childDefinition?.id ?? ''} onChange={e => select(e.target.value)}>
        {available.map(d => <option key={d.id} value={d.id}>{labels.get(d.id)}</option>)}</select></label>
      <button disabled={!childDefinition} onClick={() => change({ ...module, instances: [...module.instances, {
        id: crypto.randomUUID(), definitionId: childDefinition.id, name: childDefinition.name,
        switchStateId: childDefinition.kind === 'component' ? childDefinition.switchStates?.[0]?.id : undefined,
      }] })}>添加子实例</button>
    </fieldset>
    <fieldset><legend>端口映射</legend>{module.ports.map(p => {
      const target = module.portMappings?.find(m => m.portId === p.id)?.target;
      return <label key={p.id}>{portDisplayName(p, false, module.ports, occurrence)}<select value={target ? JSON.stringify(target) : ''} onChange={e => {
        const keep = (module.portMappings ?? []).filter(m => m.portId !== p.id);
        change({ ...module, portMappings: e.target.value ? [...keep, { portId: p.id, target: JSON.parse(e.target.value) }] : keep });
      }}><option value="">未映射</option>{ports.filter(o => o.p.type === p.type && canMapDirection(p.direction, o.p.direction)).map(o =>
        <option key={JSON.stringify(o.target)} value={JSON.stringify(o.target)}>{o.label}</option>)}</select></label>;
    })}</fieldset>
    {!!params.length && <fieldset><legend>子实例参数映射</legend>{params.map(o => {
      const matches = (m: NonNullable<ModuleDefinition['parameterMappings']>[number]) =>
        m.target.instanceId === o.target.instanceId && m.target.parameterId === o.p.id;
      return <label key={JSON.stringify(o.target)}>{o.label}<select value={module.parameterMappings?.find(matches)?.parameterId ?? ''} onChange={e => {
        const keep = (module.parameterMappings ?? []).filter(m => !matches(m));
        change({ ...module, parameterMappings: e.target.value ? [...keep, { parameterId: e.target.value, target: o.target }] : keep });
      }}><option value="">未映射</option>{module.parameters?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>;
    })}</fieldset>}
    <fieldset><legend>内部连线</legend>
      {module.connections?.map(c => {
        const from = endpoint(c.from), to = endpoint(c.to);
        return <div key={c.id}>{from?.label ?? '已移除的端口'} {wireArrow(from?.p, to?.p)} {to?.label ?? '已移除的端口'}
          <button onClick={() => change({ ...module, connections: module.connections?.filter(conn => conn.id !== c.id) })}>移除连线</button></div>;
      })}
      <form onSubmit={e => {
        e.preventDefault(); const data = new FormData(e.currentTarget);
        change({ ...module, connections: [...module.connections ?? [], { id: crypto.randomUUID(),
          from: JSON.parse(String(data.get('from'))), to: JSON.parse(String(data.get('to'))) }] });
      }}>{(['out', 'in'] as const).map(dir => <label key={dir}>{dir === 'out' ? '起点' : '终点'}<select name={dir === 'out' ? 'from' : 'to'} required>
        {ports.filter(o => supportsDirection(o.p.direction, dir)).map(o => <option key={JSON.stringify(o.target)} value={JSON.stringify(o.target)}>{o.label}</option>)}</select></label>)}
        <button type="submit" disabled={!ports.some(o => supportsDirection(o.p.direction, 'in')) || !ports.some(o => supportsDirection(o.p.direction, 'out'))}>添加连线</button></form>
    </fieldset>
    <label><input type="checkbox" checked={!!module.physicalEnclosure} onChange={e => change({ ...module,
      physicalEnclosure: e.target.checked ? { widthMm: 440, depthMm: 350, heightMm: 44.45 } : undefined })} />作为机箱</label>
    {module.physicalEnclosure && (['widthMm', 'depthMm', 'heightMm'] as const).map((k, i) =>
      <label key={k}>{['长', '宽', '高'][i]} (mm)<input type="number" step="any" defaultValue={module.physicalEnclosure![k]}
        onChange={e => change({ ...module, physicalEnclosure: { ...module.physicalEnclosure!, [k]: e.target.valueAsNumber } })} /></label>)}
  </>;
}
