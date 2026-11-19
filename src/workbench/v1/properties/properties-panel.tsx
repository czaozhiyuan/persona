import { portDisplayName, transferLabels } from '../labels';
import { useState } from 'react';
import { PortDeletionDialog } from '../../../editors/topology/v1/port-deletion-dialog';
import type { ResolvedInstance } from '../../../engine/v1/hierarchy';
import type { ParameterDefinition } from '../../../model/v1/parameters';
import type { ComponentDefinition, Instance, ModuleDefinition, Project } from '../../../model/v1/types';
import type { ProjectStore } from '../../../state/v1/project-store';
import { editModule } from '../../../state/v1/topology-edits';
import { PortFields, TransferFields } from './device-fields';
import { choice, formatValue, numberField, ParameterField, readEmpirical, readParameter, textField } from './value-fields';

type Definition = ComponentDefinition | ModuleDefinition;
const sourceLabels = { default: '定义默认值', override: '实例覆盖', mapped: '父层公开参数映射' };

function readDefault(data: FormData, parameter: ParameterDefinition): ParameterDefinition {
  const name = textField(data, 'name');
  if (!name) throw new Error('参数名称不能为空。');
  if (parameter.kind === 'enum') return { ...parameter, name, defaultValue: choice(data, 'value') || undefined };
  const min = numberField(data, 'min');
  const max = numberField(data, 'max');
  return { ...parameter, name, defaultValue: readEmpirical(data, 'value', parameter.valueKind),
    range: min === undefined && max === undefined ? undefined : { min, max } };
}

export function PropertiesPanel({ store, occurrence }: { store: ProjectStore; occurrence: ResolvedInstance }) {
  const { definition, instance, instancePath, parameters } = occurrence;
  const [error, setError] = useState('');
  const [deletion, setDeletion] = useState<string>();
  const parent = instance && store.resolveInstance(instancePath.slice(0, -1))?.definition;

  function commit(change: (draft: Project) => Project) {
    const result = store.commit(change);
    setError(result.ok ? '' : result.message);
  }

  function changeDefinition(read: () => Definition) {
    commit(draft => {
      const next = read();
      return next.kind === 'module' ? editModule(draft, next.id, () => next)
        : { ...draft, componentDefinitions: draft.componentDefinitions.map(item => item.id === next.id ? next : item) };
    });
  }

  function changeInstance(change: (current: Instance) => Instance) {
    if (!instance || parent?.kind !== 'module') return;
    commit(draft => editModule(draft, parent.id, module => ({
      ...module, instances: module.instances.map(item => item.id === instance.id ? change(item) : item),
    })));
  }

  return <section className="panel v1-properties" aria-labelledby="v1-properties-heading">
    <h2 id="v1-properties-heading">对象属性 · {instance?.name ?? definition.name}</h2>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="v1-property-columns">
      <div>
        <h3>共享定义</h3>
        <form key={definition.name} onSubmit={event => {
          event.preventDefault();
          const name = textField(new FormData(event.currentTarget), 'name');
          if (!name) { setError('定义名称不能为空。'); return; }
          changeDefinition(() => ({ ...definition, name }));
        }}>
          <label>定义名称<input name="name" defaultValue={definition.name} required /></label>
          <button type="submit">保存定义名称</button>
        </form>
        {definition.ports.map(port => <details key={port.id}>
          <summary>端口 · {portDisplayName(port.id, true)}</summary>
          <PortFields key={JSON.stringify(port)} port={port} remove={() => { setError(''); setDeletion(port.id); }}
            save={read => changeDefinition(() => ({ ...definition,
              ports: definition.ports.map(item => item.id === port.id ? read() : item),
            }))} />
        </details>)}
        {definition.parameters?.map(parameter => <details key={parameter.id}>
          <summary>参数定义 · {parameter.name}</summary>
          <form key={JSON.stringify(parameter)} onSubmit={event => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            changeDefinition(() => ({ ...definition,
              parameters: definition.parameters?.map(item => item.id === parameter.id ? readDefault(data, parameter) : item),
            }));
          }}>
            <label>参数名称<input name="name" defaultValue={parameter.name} required /></label>
            <ParameterField parameter={parameter} value={parameter.defaultValue} label="默认值" />
            {parameter.kind === 'numeric' && <div className="v1-property-pair">
              <label>允许下限<input type="number" step="any" name="min" defaultValue={parameter.range?.min} /></label>
              <label>允许上限<input type="number" step="any" name="max" defaultValue={parameter.range?.max} /></label>
            </div>}
            <button type="submit">保存参数定义</button>
          </form>
        </details>)}
        {definition.kind === 'component' && definition.transfers?.map((transfer, index) => <details key={index}>
          <summary>传输 · {transferLabels[transfer.kind]} · {portDisplayName(transfer.fromPortId, true)} → {portDisplayName(transfer.toPortId, true)}</summary>
          <TransferFields key={JSON.stringify(transfer)} transfer={transfer} definition={definition}
            save={read => changeDefinition(() => ({ ...definition,
              transfers: definition.transfers?.map((item, i) => i === index ? read() : item),
            }))} />
        </details>)}
        {definition.kind === 'component' && definition.switchStates?.map(state => <details key={state.id}>
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
      </div>
      {instance && <div>
        <h3>当前实例</h3>
        <p className="v1-property-effective">实例配置保存在父模块定义「{parent?.name}」中。</p>
        <form key={JSON.stringify([instance.name, instance.switchStateId])} onSubmit={event => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const name = textField(data, 'name');
          if (!name) { setError('实例名称不能为空。'); return; }
          changeInstance(current => ({ ...current, name, switchStateId: choice(data, 'switch') || undefined }));
        }}>
          <label>实例名称<input name="name" defaultValue={instance.name} required /></label>
          {definition.kind === 'component' && definition.switchStates && <label>开关状态
            <select name="switch" defaultValue={instance.switchStateId}>
              {definition.switchStates.map(state => <option key={state.id} value={state.id}>{state.name}</option>)}
            </select>
          </label>}
          <button type="submit">保存实例属性</button>
        </form>
        {definition.parameters?.map(parameter => {
          const effective = parameters.get(parameter.id);
          const source = effective?.source;
          const local = instance.parameterOverrides;
          const current = local && Object.hasOwn(local, parameter.id) ? local[parameter.id] : undefined;
          return <details key={parameter.id}>
            <summary>有效参数 · {parameter.name}</summary>
            <p className="v1-property-effective">{effective
              ? `${formatValue(effective.value, '；')}${parameter.kind === 'numeric' ? ' ' + parameter.unit : ''} · ${sourceLabels[effective.source.kind]}`
              : '未设置'}</p>
            {source?.kind === 'mapped' && <p>{JSON.stringify(source.instancePath)} · {source.parameterId}</p>}
            {parameter.overridable && <form key={JSON.stringify([parameter, current])} onSubmit={event => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              changeInstance(item => {
                const value = readParameter(data, 'value', parameter);
                const overrides = { ...item.parameterOverrides };
                delete overrides[parameter.id];
                const next = value === undefined ? overrides : { ...overrides, [parameter.id]: value };
                return { ...item, parameterOverrides: Object.keys(next).length ? next : undefined };
              });
            }}>
              <ParameterField parameter={parameter} value={current} label="实例覆盖（留空继承）" />
              <button type="submit">保存覆盖</button>
              {current !== undefined && <button type="button" onClick={() => changeInstance(item => {
                const overrides = { ...item.parameterOverrides };
                delete overrides[parameter.id];
                return { ...item, parameterOverrides: Object.keys(overrides).length ? overrides : undefined };
              })}>恢复继承</button>}
            </form>}
          </details>;
        })}
      </div>}
    </div>
    {deletion !== undefined && <PortDeletionDialog store={store} definitionId={definition.id}
      portId={deletion} close={() => setDeletion(undefined)} />}
  </section>;
}
