import { mediaLabels, portDisplayName } from '../../../workbench/v1/labels';
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { CableBundle, Connection, LocalEndpointRef } from '../../../model/v1/topology';
import { channelSetsOverlap } from '../../../model/v1/validate-device';
import type { ModuleDefinition, PortDefinition } from '../../../model/v1/types';

export type LocalPort = { ref: LocalEndpointRef; port: PortDefinition; label: string };
export type UpdateWiring = (change: (module: ModuleDefinition) => ModuleDefinition) => boolean;

export function TopologyTool({ title, children }: { title: string; children: ReactNode }) {
  return <details className="v1-inline-topology-tool">
    <summary>{title}</summary>
    <div className="v1-topology-popup" aria-label={title}>{children}</div>
  </details>;
}

export const field = (data: FormData, name: string) => String(data.get(name) ?? '').trim();
const endpointKey = (ref: LocalEndpointRef) => JSON.stringify([ref.instanceId, ref.portId]);
const endpointAt = (value: string, ports: readonly LocalPort[]) => ports.find(item => endpointKey(item.ref) === value)?.ref;

function EndpointSelect({ name, label, ports, value, optional }: {
  name: string; label: string; ports: readonly LocalPort[]; value?: LocalEndpointRef; optional?: boolean;
}) {
  return <label>{label}
    <select name={name} defaultValue={value ? endpointKey(value) : ''} required={!optional}>
      <option value="">{optional ? '未接' : '请选择'}</option>
      {ports.map(({ ref, label }) => <option key={endpointKey(ref)} value={endpointKey(ref)}>{label}</option>)}
    </select>
  </label>;
}

export function ConnectionForm({ module, ports, update }: { module: ModuleDefinition; ports: readonly LocalPort[]; update: UpdateWiring }) {
  const [selected, setSelected] = useState('');
  const connection = module.connections?.find(item => item.id === selected);
  const label = (ref: LocalEndpointRef) => ports.find(item => endpointKey(item.ref) === endpointKey(ref))?.label;
  return <TopologyTool title="连线">
    <label>已有连接<select value={connection?.id ?? ''} onChange={event => setSelected(event.target.value)}>
      <option value="">新增连接</option>
      {module.connections?.map(item => <option key={item.id} value={item.id}>{label(item.from)} → {label(item.to)}</option>)}
    </select></label>
    <form key={JSON.stringify(connection ?? null)} onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const from = endpointAt(field(data, 'from'), ports);
      const to = endpointAt(field(data, 'to'), ports);
      if (!from || !to) return;
      const id = connection?.id ?? crypto.randomUUID();
      const mediaKind = (field(data, 'media') || undefined) as Connection['mediaKind'];
      const next = { id, from, to, mediaKind };
      if (update(current => ({
        ...current, connections: [...(current.connections ?? []).filter(item => item.id !== id), next],
      }))) setSelected(id);
    }}>
      <EndpointSelect name="from" label="连接起点" ports={ports.filter(item => item.port.direction === 'out')} value={connection?.from} />
      <EndpointSelect name="to" label="连接终点" ports={ports.filter(item => item.port.direction === 'in')} value={connection?.to} />
      <label>介质<select name="media" defaultValue={connection?.mediaKind ?? ''}>
        <option value="">未指定</option>{Object.entries(mediaLabels).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
      </select></label>
      <button type="submit">{connection ? '保存连接' : '添加连接'}</button>
      {connection && <button type="button" onClick={() => {
        if (update(current => ({ ...current, connections: current.connections?.filter(item => item.id !== connection.id) }))) setSelected('');
      }}>删除连接</button>}
    </form>
  </TopologyTool>;
}

export function MappingForm({ module, ports, connect }: {
  module: ModuleDefinition; ports: readonly LocalPort[]; connect: (portId: string, target?: LocalEndpointRef) => void;
}) {
  const [selected, setSelected] = useState('');
  const publicPort = module.ports.find(item => item.id === selected);
  const mapping = module.portMappings?.find(item => item.portId === selected);
  const candidates = publicPort ? ports.filter(item => item.port.type === publicPort.type
    && item.port.direction === publicPort.direction && channelSetsOverlap(publicPort, item.port)) : [];
  return <TopologyTool title="连接到内部端口">
    <label>对外端口<select value={publicPort?.id ?? ''} onChange={event => setSelected(event.target.value)}>
      <option value="">请选择</option>
      {module.ports.map(port => <option key={port.id} value={port.id}>{portDisplayName(port, true, module.ports)}{module.portMappings?.some(item => item.portId === port.id) ? '' : '（开放）'}</option>)}
    </select></label>
    {publicPort && <form key={JSON.stringify([selected, mapping])} onSubmit={event => {
      event.preventDefault();
      const target = endpointAt(field(new FormData(event.currentTarget), 'target'), candidates);
      if (!target) return;
      connect(selected, target);
    }}>
      <EndpointSelect name="target" label="内部端口" ports={candidates} value={mapping?.target} />
      <button type="submit">保存内部连接</button>
      {mapping && <button type="button" onClick={() => connect(selected)}>解除内部连接</button>}
    </form>}
  </TopologyTool>;
}

function CoreForm({ bundle, ports, update }: { bundle: CableBundle; ports: readonly LocalPort[]; update: (bundle: CableBundle) => boolean }) {
  const [selected, setSelected] = useState('');
  const core = bundle.cores.find(item => item.id === selected);
  const label = (ref?: LocalEndpointRef) => ref ? ports.find(item => endpointKey(item.ref) === endpointKey(ref))?.label : '未接';
  return <>
    <label>纤芯<select value={core?.id ?? ''} onChange={event => setSelected(event.target.value)}>
      <option value="">新增纤芯</option>
      {bundle.cores.map(item => <option key={item.id} value={item.id}>
        A:{item.a.pin} {label(item.a.endpoint)} / B:{item.b.pin} {label(item.b.endpoint)}
      </option>)}
    </select></label>
    <form key={JSON.stringify(core ?? null)} onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const id = core?.id ?? crypto.randomUUID();
      const side = (key: 'a' | 'b') => ({ pin: Number(field(data, key + 'Pin')), endpoint: endpointAt(field(data, key), ports) });
      if (update({ ...bundle, cores: [...bundle.cores.filter(item => item.id !== id), { id, a: side('a'), b: side('b') }] })) setSelected(id);
    }}>
      <label>A 端芯号<input name="aPin" type="number" min={1} max={bundle.coreCount} defaultValue={core?.a.pin} required /></label>
      <EndpointSelect name="a" label="A 端附件" ports={ports} value={core?.a.endpoint} optional />
      <label>B 端芯号<input name="bPin" type="number" min={1} max={bundle.coreCount} defaultValue={core?.b.pin} required /></label>
      <EndpointSelect name="b" label="B 端附件" ports={ports} value={core?.b.endpoint} optional />
      <button type="submit">{core ? '保存纤芯' : '添加纤芯'}</button>
      {core && <button type="button" onClick={() => {
        if (update({ ...bundle, cores: bundle.cores.filter(item => item.id !== core.id) })) setSelected('');
      }}>删除纤芯</button>}
    </form>
  </>;
}

export function CableForm({ module, ports, update }: { module: ModuleDefinition; ports: readonly LocalPort[]; update: UpdateWiring }) {
  const [selected, setSelected] = useState('');
  const bundle = module.cableBundles?.find(item => item.id === selected);
  const save = (item: CableBundle) => update(current => ({
    ...current, cableBundles: bundle ? current.cableBundles?.map(existing => existing.id === bundle.id ? item : existing) : [...(current.cableBundles ?? []), item],
  }));
  return <TopologyTool title="MPO 芯序">
    <label>线缆<select value={bundle?.id ?? ''} onChange={event => setSelected(event.target.value)}>
      <option value="">新增线缆</option>
      {module.cableBundles?.map((item, index) => <option key={item.id} value={item.id}>线缆 {index + 1}（{item.coreCount} 芯）</option>)}
    </select></label>
    <form key={JSON.stringify([bundle?.id, bundle?.coreCount])} onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const coreCount = Number(field(data, 'count'));
      const id = bundle?.id ?? crypto.randomUUID();
      if (save({ id, coreCount, cores: bundle?.cores ?? [] })) setSelected(id);
    }}>
      <label>芯数<input name="count" type="number" min={1} defaultValue={bundle?.coreCount ?? 12} required /></label>
      <button type="submit">{bundle ? '保存芯数' : '添加线缆'}</button>
      {bundle && <button type="button" onClick={() => {
        if (update(current => ({ ...current, cableBundles: current.cableBundles?.filter(item => item.id !== bundle.id) }))) setSelected('');
      }}>删除线缆</button>}
    </form>
    {bundle && <CoreForm key={bundle.id} bundle={bundle} ports={ports.filter(item => item.port.type === 'OPTICAL')} update={save} />}
  </TopologyTool>;
}
