import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { PortDeletionDialog } from '../../../editors/topology/v1/port-deletion-dialog';
import type { ResolvedInstance } from '../../../engine/v1/hierarchy';
import { canSetSupplyCapacity, isPowerPort, portDirectionLabels, supportsDirection } from '../../../model/v1/types';
import type { PortDefinition, PortDirection, PortType } from '../../../model/v1/types';
import { addDefinitionPort, updateDefinitionPort } from '../../../state/v1/module-ports';
import type { ProjectStore } from '../../../state/v1/project-store';
import { editablePortName, portDisplayName, portTypeLabels } from '../labels';
import { PortParameterFields, readPort } from './device-fields';
import { ratingUnits } from './input-rating-field';
import { createPortVoltageDraft, readPortVoltage } from './port-voltage-field';
import { WdmPortDialog } from './wdm-configuration';

function signature(form: HTMLFormElement) {
  return JSON.stringify(Array.from(new FormData(form).entries()));
}

type PortPreview = { name: string; type: PortType; direction: PortDirection };

function portPreview(form: HTMLFormElement, seed: PortDefinition, owner: ResolvedInstance): PortPreview {
  const data = new FormData(form);
  const { type, direction } = seed;
  const voltageField = direction === 'in' ? 'inputVoltageV' : 'outputVoltageV';
  const name = isPowerPort(type)
    ? portDisplayName({ ...seed, [voltageField]: readPortVoltage(data, direction) }, false, undefined, owner)
    : String(data.get('name') ?? '').trim() || '新建端口';
  return { name, type, direction };
}

export type PortManagerMode = 'create' | 'manage';

type PortManagerProps = {
  initialMode: PortManagerMode;
  owner: ResolvedInstance; name: string; locations: readonly string[]; store: ProjectStore;
  added: (id: string) => void; close: () => void;
};

export function PortManagerDialog(props: PortManagerProps) {
  const { definition } = props.owner;
  return definition.kind === 'component' && definition.wdm
    ? <WdmPortDialog {...props} definition={definition} /> : <StandardPortDialog {...props} />;
}

function StandardPortDialog({ initialMode, name, owner, locations, store, added, close }: PortManagerProps) {
  const { ports, id: definitionId } = owner.definition;
  const [selected, setSelected] = useState<string | undefined>(initialMode === 'create' ? undefined : ports[0]?.id);
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<PortPreview>({ name: '新建端口', type: 'RF', direction: 'in' });
  const [deletion, setDeletion] = useState<string>();
  const port = ports.find(item => item.id === selected);
  const form = useRef<HTMLFormElement>(null);
  const initial = useRef('');
  const draftEdited = useRef(false);
  const selectedRow = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    draftEdited.current = false;
    if (form.current) initial.current = signature(form.current);
    selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [selected, revision]);

  function dirty() {
    return !!form.current && (!!port || draftEdited.current) && (signature(form.current) !== initial.current ||
      Array.from(form.current.querySelectorAll('input')).some(input => input.validity.badInput));
  }
  function discard() {
    return !dirty() || window.confirm('放弃尚未保存的端口修改？');
  }
  function leave() {
    if (discard()) close();
  }
  function select(id?: string) {
    if (!discard()) return;
    setSelected(id);
    setRevision(value => value + 1);
  }
  function save(next: PortDefinition) {
    if (port && !dirty()) return;
    if (port && JSON.stringify(next) === JSON.stringify(port)) {
      setRevision(value => value + 1);
      return;
    }
    const result = store.commit(project => port
      ? updateDefinitionPort(project, definitionId, next) : addDefinitionPort(project, definitionId, next));
    if (!result.ok) throw new Error(result.message);
    if (!port) added(next.id);
    setSelected(next.id);
    setRevision(value => value + 1);
  }

  return <>
    <dialog ref={dialog => { if (dialog && !dialog.open) dialog.showModal(); }}
      className="v1-topology-dialog v1-add-port-dialog" aria-labelledby="port-manager-title"
      onCancel={event => { event.preventDefault(); leave(); }}
      onFocusCapture={() => {
        // Include defaults populated before the user starts editing the draft.
        if (!port && !draftEdited.current && form.current) initial.current = signature(form.current);
      }}
      onInputCapture={() => { draftEdited.current = true; }}>
      <h3 id="port-manager-title">端口管理 · {name}</h3>
      {locations.length > 0 && <p className="v1-port-scope">共享定义 · 端口变更会应用到 {locations.join('、')}。</p>}
      <div className="v1-port-manager">
        <section className="v1-port-list">
          <h4>当前端口</h4>
          <div className="v1-port-rows">
            {ports.map(item => <button key={item.id} type="button" aria-pressed={item.id === selected}
              ref={item.id === selected ? selectedRow : undefined}
              onClick={() => { if (item.id !== selected) select(item.id); }}>
              <strong>{portDisplayName(item, false, ports, owner)}</strong>
              <span>{portTypeLabels[item.type]}</span><span>{portDirectionLabels[item.direction]}</span>
            </button>)}
            {!port && <button type="button" aria-pressed="true" ref={selectedRow}>
              <strong>{preview.name} <span>未保存</span></strong>
              <span>{portTypeLabels[preview.type]}</span><span>{portDirectionLabels[preview.direction]}</span>
            </button>}
          </div>
          <div className="v1-port-new"><button type="button" onClick={() => select()}>＋ 新建端口</button></div>
        </section>
        <PortDetail key={revision} form={form} port={port} owner={owner} preview={port ? undefined : setPreview} save={save} close={leave} remove={() => {
          if (port && discard()) {
            setRevision(value => value + 1);
            setDeletion(port.id);
          }
        }} />
      </div>
    </dialog>
    {deletion && <PortDeletionDialog store={store} definitionId={definitionId} portId={deletion}
      close={() => setDeletion(undefined)} onDeleted={() => {
        const index = ports.findIndex(item => item.id === deletion);
        setSelected((ports[index + 1] ?? ports[index - 1])?.id);
        setRevision(value => value + 1);
      }} />}
  </>;
}

function PortDetail({ form, port, owner, preview, save, remove, close }: {
  form: RefObject<HTMLFormElement | null>; port?: PortDefinition; owner: ResolvedInstance;
  preview?: (summary: PortPreview) => void;
  save: (next: PortDefinition) => void; remove: () => void; close: () => void;
}) {
  const [seed, setSeed] = useState<PortDefinition>(() => port ?? { id: crypto.randomUUID(), type: 'RF', direction: 'in' });
  const [draftVoltage] = useState(() => port ? undefined : createPortVoltageDraft());
  const [error, setError] = useState('');
  const { type, direction } = seed;
  useLayoutEffect(() => {
    if (preview && form.current) preview(portPreview(form.current, seed, owner));
  }, [preview, form, seed, owner]);

  function change(nextType: PortType, nextDirection: PortDirection) {
    if (nextType !== 'OPTICAL' && nextDirection === 'bidirectional') nextDirection = 'in';
    const power = isPowerPort(nextType);
    const voltage = draftVoltage?.(new FormData(form.current!), seed, { type: nextType, direction: nextDirection }, owner.definition);
    const ratings = ratingUnits(nextType, nextDirection);
    setSeed({ ...seed, type: nextType, direction: nextDirection,
      name: power ? undefined : seed.name,
      channelIds: nextType === 'OPTICAL' ? seed.channelIds : undefined,
      opticalEmitter: nextType === 'OPTICAL' && supportsDirection(nextDirection, 'out') ? seed.opticalEmitter : undefined,
      inputRating: seed.inputRating && ratings.includes(seed.inputRating.unit) ? seed.inputRating : undefined,
      inputVoltageV: nextDirection === 'in' ? voltage : undefined,
      outputVoltageV: nextDirection === 'out' ? voltage : undefined,
      supplyCapacity: nextType === seed.type && canSetSupplyCapacity(owner.definition, { type: nextType, direction: nextDirection }) ? seed.supplyCapacity : undefined,
      acLoadW: nextType === 'AC_POWER' && nextDirection === 'in' ? seed.acLoadW : undefined,
    });
  }
  return <form ref={form} onChange={event => {
    setError('');
    if (preview && !(event.target instanceof HTMLInputElement && event.target.type === 'radio')) {
      preview(portPreview(event.currentTarget, seed, owner));
    }
  }} onSubmit={event => {
    event.preventDefault();
    try { save(readPort(new FormData(event.currentTarget), seed)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }}>
    <h4>{port ? '端口详情' : '新建端口'}</h4>
    <div className="v1-port-detail-fields">
      {!isPowerPort(type) && <label>端口名称<textarea rows={2} name="name" required={!port} defaultValue={editablePortName(seed)}
        placeholder={port ? portDisplayName(seed) : undefined} /></label>}
      <div className="v1-port-choices">
        <fieldset className="v1-port-radio-group">
          <legend>类型</legend>
          {Object.entries(portTypeLabels).map(([value, label]) => <label key={value}>
            <input type="radio" name="type" value={value} checked={type === value} onChange={() => change(value as PortType, direction)} />{value} · {label}
          </label>)}
        </fieldset>
        <fieldset className="v1-port-radio-group">
          <legend>方向</legend>
          {(['in', 'out', 'bidirectional'] as const).filter(value => type === 'OPTICAL' || value !== 'bidirectional').map(value => <label key={value}>
            <input type="radio" name="direction" value={value} checked={direction === value}
              onChange={() => change(type, value)} />{portDirectionLabels[value]}
          </label>)}
        </fieldset>
        <fieldset className="v1-port-parameters">
          <legend>端口参数</legend><PortParameterFields port={seed} occurrence={owner} draft />
        </fieldset>
      </div>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="actions">
      <button type="submit" className="primary">{port ? '保存修改' : '添加端口'}</button>
      {port && <button type="button" className="v1-port-delete" onClick={remove}>删除端口</button>}
      <button type="button" onClick={close}>取消</button>
    </div>
  </form>;
}
