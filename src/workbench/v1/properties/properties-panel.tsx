import { portDirectionLabels } from '../../../model/v1/types';
import { moduleName } from '../../../state/v1/module-name';
import { componentIconLabels, portDisplayName, portTypeLabels, transferLabels } from '../labels';
import { useState } from 'react';
import { PortDeletionDialog } from '../../../editors/topology/v1/port-deletion-dialog';
import type { ResolvedInstance } from '../../../engine/v1/hierarchy';
import type { ParameterDefinition } from '../../../model/v1/parameters';
import { componentIconKeys } from '../../../model/v1/types';
import type { ComponentDefinition, InstancePath, InstanceSettings, ModuleDefinition, Project } from '../../../model/v1/types';
import type { ProjectStore } from '../../../state/v1/project-store';
import { editInstanceSettings } from '../../../state/v1/instance-settings';
import { instantiateModule } from '../../../state/v1/instantiate-module';
import { structureScope } from '../structure-scope';
import { editModule } from '../../../state/v1/topology-edits';
import { ReceiverPreview, receiverParameterVisible } from './receiver-properties';
import type { ReceiverQuery } from './receiver-properties';
import { resolveEmpiricalValue } from '../../../engine/v1/empirical-value';
import { DcLoadFields } from './dc-load-fields';
import { AddConversion } from './add-conversion';
import { AutosaveForm } from './autosave-form';
import { PortFields, TransferFields } from './device-fields';
import { choice, formatValue, numberField, ParameterField, readNumericParameter, readParameter, textField } from './value-fields';
import { definitionIcon, DeviceIcon } from '../../../editors/topology/v1/device-icon';

type Definition = ComponentDefinition | ModuleDefinition;
const sourceLabels = { default: '定义默认值', override: '当前实例单独设置', mapped: '由上级设置' };

function readDefault(data: FormData, parameter: ParameterDefinition): ParameterDefinition {
  const name = textField(data, 'name');
  if (!name) throw new Error('参数名称不能为空。');
  if (parameter.kind === 'enum') return { ...parameter, name, defaultValue: choice(data, 'value') || undefined };
  const min = numberField(data, 'min');
  const max = numberField(data, 'max');
  return { ...parameter, name, defaultValue: readNumericParameter(data, 'value', parameter),
    range: min === undefined && max === undefined ? undefined : { min, max } };
}

export function PropertiesPanel({ store, occurrence, occurrences, receiverQuery, jumpToParameter, onAddPort, onCopyModule, onMoveUp, onDissolve, onAddInside, onDcBudget }: {
  store: ProjectStore; occurrence: ResolvedInstance; occurrences: readonly ResolvedInstance[];
  receiverQuery: (portId: string) => ReceiverQuery;
  onAddPort: (path: InstancePath) => void;
  onCopyModule: (path: InstancePath) => void;
  onAddInside?: (path: InstancePath) => void;
  onDcBudget?: (path: InstancePath) => void;
  onMoveUp?: (path: InstancePath) => void;
  onDissolve?: (path: InstancePath) => void;
  jumpToParameter: (path: InstancePath, parameterId: string) => void;
}) {
  const { definition, instance, instancePath, parameters, settings } = occurrence;
  const wdm = definition.kind === 'component' && definition.wdm;
  const [error, setError] = useState('');
  const [deletion, setDeletion] = useState<string>();
  const parentPath = instancePath.slice(0, -1);
  const parent = instance && store.resolveInstance(parentPath)?.definition;
  const enclosure = definition.kind === 'module' ? definition.physicalEnclosure : undefined;
  const sharedLocations = structureScope(occurrences, definition.id);
  const parentLocations = parent ? structureScope(occurrences, parent.id) : [];

  function commit(change: (draft: Project) => Project) {
    const result = store.commit(change);
    setError(result.ok ? '' : result.message);
    return result.ok;
  }

  function changeDefinition(read: () => Definition) {
    return commit(draft => {
      const next = read();
      return next.kind === 'module' ? editModule(draft, next.id, () => next)
        : { ...draft, componentDefinitions: draft.componentDefinitions.map(item => item.id === next.id ? next : item) };
    });
  }

  function changeInstance(change: (current: InstanceSettings) => InstanceSettings) {
    if (instance) return commit(draft => editInstanceSettings(draft, instancePath, change));
  }

  function saveName(input: HTMLInputElement) {
    const owner = store.resolveInstance(instancePath);
    if (!owner) return;
    const previous = owner.instance?.name ?? owner.definition.name;
    const name = input.value.trim();
    if (!name) {
      if (owner.definition.kind !== 'module') input.value = previous;
      setError('名称不能为空。');
      return;
    }
    input.value = name;
    if (name === previous) {
      setError('');
      return;
    }
    const saved = owner.instance
      ? commit(draft => editInstanceSettings(draft, instancePath, current => ({ ...current, name })))
      : commit(draft => editModule(draft, owner.definition.id, current => ({ ...current, name: moduleName(draft, name, { except: [] }) })));
    if (!saved && owner.definition.kind !== 'module') input.value = previous;
  }

  function reuseModule() {
    const id = crypto.randomUUID();
    if (commit(draft => instantiateModule(draft, instancePath, 'reuse', id, () => crypto.randomUUID()))) {
      store.selectModule(parentPath);
      store.selectInstance([...parentPath, id]);
    }
  }

  function parameterLocation(path: InstancePath, id: string) {
    let owner = store.resolveInstance(path);
    let source = owner?.parameters.get(id)?.source;
    while (source?.kind === 'mapped') {
      path = source.instancePath;
      id = source.parameterId;
      owner = store.resolveInstance(path);
      source = owner?.parameters.get(id)?.source;
    }
    return { path, id, name: owner?.instance?.name ?? owner?.definition.name,
      parameterName: owner?.definition.parameters?.find(parameter => parameter.id === id)?.name ?? '未找到的参数' };
  }

  const detectors = definition.kind === 'component' ? definition.transfers?.filter(t => t.kind === 'oe') ?? [] : [];
  const visibleParameters = definition.parameters?.filter(parameter =>
    !detectors.length || receiverParameterVisible(occurrence, parameter.id));
  const name = instance?.name ?? definition.name;
  const nameField = <label>名称<input key={name} name="name" defaultValue={name} data-object-name={instance ? true : undefined} required
    onBlur={event => saveName(event.currentTarget)}
    onKeyDown={event => {
      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.currentTarget.blur();
    }} /></label>;

  return <section className="panel v1-properties" aria-labelledby="v1-properties-heading">
    <h2 id="v1-properties-heading"><DeviceIcon iconKey={definitionIcon(definition)} /><span>对象属性 · {name}</span></h2>
    {(onMoveUp || onAddInside || onDcBudget) && <div className="v1-context-actions">
      {onAddInside && <button type="button" onClick={() => onAddInside(instancePath)}>添加内部对象 · {name}</button>}
      {onMoveUp && <button type="button" onClick={() => onMoveUp(instancePath)}>移到上一级</button>}
      {onDcBudget && <button type="button" onClick={() => onDcBudget(instancePath)}>查看供电/功耗 · {name}</button>}
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
    <p className="v1-property-effective">名称、端口和参数自动保存。文本和数值按 Enter 或离开输入框时应用，多行文本离开输入框时应用。</p>
    {!instance && nameField}
    <div className="v1-inspector-fields">
      {instance && <div className="v1-common-properties">
        <p className="v1-property-effective">名称、状态和参数设置只应用于当前实例。</p>
        {nameField}
        {definition.kind === 'component' && !!definition.switchStates?.length && <label>开关状态
          <select name="switch" value={instance.switchStateId ?? ''} onChange={event => {
            const switchStateId = event.currentTarget.value;
            if (switchStateId !== instance.switchStateId) changeInstance(current => ({ ...current, switchStateId }));
          }}>
            {instance.switchStateId === undefined && <option value="" disabled>未设置</option>}
            {definition.switchStates.map(state => <option key={state.id} value={state.id}>{state.name}</option>)}
          </select>
        </label>}
        {!!visibleParameters?.length && <h3>参数</h3>}
        {visibleParameters?.map(parameter => {
          const effective = parameters.get(parameter.id);
          const source = effective?.source;
          const local = settings?.parameterOverrides;
          const current = local && Object.hasOwn(local, parameter.id) ? local[parameter.id] : undefined;
          const controlling = source?.kind === 'mapped' ? parameterLocation(source.instancePath, source.parameterId) : undefined;
          const sourceLabel = source?.kind === 'override' && current === undefined ? '模块内默认设置'
            : source && sourceLabels[source.kind];
          return <details key={parameter.id} data-effective-parameter={parameter.id}>
            <summary>{parameter.name}<span className="v1-parameter-value">{effective
              ? `${formatValue(effective.value, '；')}${parameter.kind === 'numeric' ? ' ' + parameter.unit : ''} · ${sourceLabel}`
              : '未设置'}</span></summary>
            {controlling && <div className="v1-property-effective">
              <p>由上级「{controlling.name}」的「{controlling.parameterName}」设置。</p>
              <button type="button" onClick={() => jumpToParameter(controlling.path, controlling.id)}>转到来源参数</button>
            </div>}
            {parameter.overridable && !controlling && <AutosaveForm version={JSON.stringify([parameter, current])} save={data => {
              const owner = store.resolveInstance(instancePath);
              if (owner?.parameters.get(parameter.id)?.source.kind === 'mapped') return;
              try {
                const value = readParameter(data, 'value', parameter);
                if (JSON.stringify(value) === JSON.stringify(current)) return;
                if (changeInstance(item => {
                  const overrides = { ...item.parameterOverrides };
                  delete overrides[parameter.id];
                  const next = value === undefined ? overrides : { ...overrides, [parameter.id]: value };
                  return { ...item, parameterOverrides: Object.keys(next).length ? next : undefined };
                })) return JSON.stringify([parameter, value]);
              } catch (error) {
                setError((error as Error).message);
              }
            }}>
              <ParameterField parameter={parameter} value={current} inherited={effective?.value} label="当前实例值（留空恢复默认）" autosave />
              {current !== undefined && <button type="button" data-skip-autosave onClick={() => changeInstance(item => {
                const overrides = { ...item.parameterOverrides };
                delete overrides[parameter.id];
                return { ...item, parameterOverrides: Object.keys(overrides).length ? overrides : undefined };
              })}>恢复继承</button>}
            </AutosaveForm>}
          </details>;
        })}
        {definition.kind === 'component' && definition.transfers?.map(transfer => {
          if (transfer.kind !== 'splitter') return null;
          const first = resolveEmpiricalValue('%', transfer.firstPercent, {}, occurrence);
          const label = (id: string) => portDisplayName(definition.ports.find(port => port.id === id)!, true, definition.ports);
          return <p className="v1-property-effective" key={JSON.stringify([transfer.fromPortId, transfer.toPortId])}>
            {label(transfer.toPortId)} / {label(transfer.secondPortId)} · {first.availability === 'available'
              ? `${first.value}% / ${Number((100 - first.value).toPrecision(12))}%` : '分光比未设置'}
          </p>;
        })}
        {detectors.map(pd => <ReceiverPreview key={JSON.stringify([pd.fromPortId, pd.toPortId])} pd={pd}
          instance={occurrence} query={receiverQuery(pd.fromPortId)} showPorts={detectors.length > 1} />)}
      </div>}
      {instance && definition.kind === 'module' && <section>
        <h3>模块操作</h3>
        {onDissolve && <button type="button" onClick={() => onDissolve(instancePath)}>解散模块（保留内部对象）</button>}
        {parentLocations.length > 0 && <p className="v1-property-effective">在上级模块添加后，以下位置都会新增此对象：{parentLocations.join('、')}。</p>}
        <button type="button" title="共用此模块定义，结构修改会应用到所有复用位置" onClick={reuseModule}>再次使用此模块</button>
        <button type="button" onClick={() => onCopyModule(instancePath)}>复制为独立模块</button>
      </section>}
      {definition.kind === 'module' && enclosure && <section>
        <h3>机箱尺寸</h3>
        {sharedLocations.length > 0 && <p className="v1-property-effective">共享定义 · 影响 {sharedLocations.join('、')}</p>}
        <form key={JSON.stringify(enclosure)} onSubmit={event => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          changeDefinition(() => ({ ...definition, physicalEnclosure: {
            widthMm: Number(data.get('width')), depthMm: Number(data.get('depth')), heightMm: Number(data.get('height')),
          } }));
        }}>
          <div className="v1-enclosure-dimensions">
            <label>宽 (mm)<input type="number" name="width" min="0.001" step="any" defaultValue={enclosure.widthMm} required /></label>
            <label>深 (mm)<input type="number" name="depth" min="0.001" step="any" defaultValue={enclosure.depthMm} required /></label>
            <label>高 (mm)<input type="number" name="height" min="0.001" step="any" defaultValue={enclosure.heightMm} required /></label>
          </div>
          <button type="submit">保存机箱尺寸</button>
        </form>
      </section>}
      <section className="v1-object-ports">
        <div className="v1-object-ports-heading">
          <h3>端口</h3>
          <button type="button" className="primary" aria-haspopup="dialog" onClick={() => onAddPort(instancePath)}>{wdm ? '配置波长端口' : '端口管理'}</button>
        </div>
        <p className="v1-property-effective">编辑目标 · {instance?.name ?? definition.name}{definition.kind === 'module' && '（模块对外端口）'}</p>
        {sharedLocations.length > 0 && <p className="v1-property-effective">共享定义 · 影响 {sharedLocations.join('、')}</p>}
        {!definition.ports.length && <p className="empty">暂无端口。</p>}
        {wdm ? definition.ports.map(port => <p key={port.id} data-port-id={port.id}>{portDisplayName(port, false, definition.ports, occurrence)}
          {' · ' + portDirectionLabels[port.direction]}{port.channelIds && port.name !== port.channelIds[0] && ' · ' + port.channelIds[0]}</p>)
          : definition.ports.map(port => <details key={port.id} data-port-id={port.id}>
          <summary>{portDisplayName(port, false, definition.ports, occurrence)}<span className="v1-parameter-value">
            {portTypeLabels[port.type]} · {portDirectionLabels[port.direction]}
          </span></summary>
          <PortFields port={port} occurrence={occurrence} remove={() => { setError(''); setDeletion(port.id); }}
            save={next => changeDefinition(() => ({ ...definition,
              ports: definition.ports.map(item => item.id === port.id ? next : item),
            }))} />
        </details>)}
      </section>
      <details className="v1-advanced-properties">
        <summary>高级设置 · {sharedLocations.length ? '共享定义' : '当前定义'}</summary>
        {sharedLocations.length > 0 && <p className="v1-property-effective">改动会应用到 {sharedLocations.join('、')}。</p>}
        {definition.kind === 'component' && <label>框图图标
          <select value={definition.iconKey ?? ''} onChange={event => {
            const iconKey = componentIconKeys.find(key => key === event.currentTarget.value);
            changeDefinition(() => ({ ...definition, iconKey }));
          }}>
            <option value="">通用器件</option>
            {componentIconKeys.map(key => <option key={key} value={key}>{componentIconLabels[key]}</option>)}
          </select>
        </label>}
        {instance && <form key={definition.name} onSubmit={event => {
          event.preventDefault();
          const name = textField(new FormData(event.currentTarget), 'name');
          if (!name) { setError('定义名称不能为空。'); return; }
          changeDefinition(() => ({ ...definition, name }));
        }}>
          <label>定义名称<input name="name" defaultValue={definition.name} required /></label>
          <button type="submit">保存定义名称</button>
        </form>}
        {definition.parameters?.map(parameter => <details key={parameter.id} data-definition-parameter={parameter.id}>
          <summary>参数定义 · {parameter.name}</summary>
          <AutosaveForm version={JSON.stringify(parameter)} save={data => {
            try {
              const next = readDefault(data, parameter);
              const version = JSON.stringify(next);
              if (version === JSON.stringify(parameter)) return;
              if (changeDefinition(() => ({ ...definition,
                parameters: definition.parameters?.map(item => item.id === parameter.id ? next : item),
              }))) return version;
            } catch (error) {
              setError((error as Error).message);
            }
          }}>
            <label>参数名称<input name="name" defaultValue={parameter.name} required /></label>
            <ParameterField parameter={parameter} value={parameter.defaultValue} label="定义默认值" autosave />
            {parameter.kind === 'numeric' && <div className="v1-property-pair">
              <label>允许下限<input type="number" step="any" name="min" defaultValue={parameter.range?.min} /></label>
              <label>允许上限<input type="number" step="any" name="max" defaultValue={parameter.range?.max} /></label>
            </div>}
          </AutosaveForm>
        </details>)}
        {definition.kind === 'component' && <DcLoadFields parameters={parameters} key={JSON.stringify([definition.dcLoad,
          definition.ports.filter(p => p.type === 'DC_POWER' && p.direction === 'in').map(p => p.id)])}
          definition={definition} save={read => changeDefinition(() => ({ ...definition, dcLoad: read() }))} />}
        {definition.kind === 'component' && !wdm && <AddConversion definition={definition} add={transfer =>
          changeDefinition(() => ({ ...definition, transfers: [...(definition.transfers ?? []), transfer] }))} />}
        {definition.kind === 'component' && !wdm && definition.transfers?.map((transfer, index) => <details key={index}>
          <summary>传输 · {transferLabels[transfer.kind]} · {portDisplayName(definition.ports.find(port => port.id === transfer.fromPortId)!, true, definition.ports, occurrence)} → {portDisplayName(definition.ports.find(port => port.id === transfer.toPortId)!, true, definition.ports, occurrence)}</summary>
          <TransferFields effective={parameters} transfer={transfer} definition={definition} occurrences={occurrences}
            save={read => changeDefinition(() => ({ ...definition,
              transfers: definition.transfers?.map((item, i) => i === index ? read() : item),
            }))} />
        </details>)}
        {definition.kind === 'component' && definition.switchStates?.filter(state => state.routes.length).map(state => <details key={state.id}>
          <summary>开关路由 · {state.name}</summary>
          {state.routes.map((route, index) => <TransferFields key={JSON.stringify([index, route])}
            transfer={{ ...route, kind: 'optical' }} definition={definition}
            save={read => changeDefinition(() => {
              const next = read();
              if (next.kind !== 'optical') return definition;
              const { fromPortId, toPortId, channelIds, gainDb } = next;
              return { ...definition, switchStates: definition.switchStates?.map(item => item.id !== state.id ? item : {
                ...item, routes: item.routes.map((current, i) => i === index ? { fromPortId, toPortId, channelIds, gainDb } : current),
              }) };
            })} />)}
        </details>)}
      </details>
    </div>
    {deletion !== undefined && <PortDeletionDialog store={store} definitionId={definition.id}
      portId={deletion} close={() => setDeletion(undefined)} />}
  </section>;
}
