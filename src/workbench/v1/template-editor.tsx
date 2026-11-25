import { supportsDirection } from '../../model/v1/types';
import { transferTypes } from '../../model/v1/validate-device';
import { readParameters, withMappedVoltages } from '../../engine/v1/hierarchy';
import { useRef, useState } from 'react';
import type { LibraryDefinition } from '../../library/v1/project-snapshots';
import type { Transfer } from '../../model/v1/device';
import type { PortDefinition } from '../../model/v1/types';
import { projectErrorMessage } from '../../storage/v1/project-json';
import { portDisplayName, transferLabels } from './labels';
import { PortFields, readPort, readTransfer, TransferFields } from './properties/device-fields';
import { readParameter } from './properties/value-fields';
import { curveProblem } from './properties/curve-graph';
import { readPower, TemplatePower } from './template-power';
import { TemplateSwitch, readSwitchStates } from './template-switch';
import { TemplateModule } from './template-module';
import { controlTransferKind, conversionCandidates } from './properties/add-conversion';
import { TemplateParameter } from './template-parameter';

export function TemplateEditor({ initial, definitions, hidden, save, cancel, report }: {
  initial: LibraryDefinition; definitions: LibraryDefinition[]; hidden: readonly string[]; save: (value: LibraryDefinition) => void;
  cancel: () => void; report: (message: string) => void;
}) {
  const [draft, edit] = useState(initial);
  const [rows, setRows] = useState(() => (initial.kind === 'component' ? initial.transfers ?? [] : [])
    .map(t => ({ key: crypto.randomUUID(), transfer: t, pair: { fromPortId: t.fromPortId, toPortId: t.toPortId } })));
  const [kind, setKind] = useState<Transfer['kind']>('rf');
  const body = useRef<HTMLDivElement>(null);
  const controlPairs = draft.kind === 'component' ? conversionCandidates({ ...draft, transfers: rows.map(row => ({ ...row.transfer, ...row.pair })) })
    .flatMap(({ input, outputs }) => outputs.flatMap(output => {
      const kind = controlTransferKind(input, output);
      return kind ? [{ kind, fromPortId: input.id, toPortId: output.id }] : [];
    })) : [];
  const splitInput = draft.ports.find(p => supportsDirection(p.direction, 'in') && p.type === 'OPTICAL');
  const splitOutputs = draft.ports.filter(p => p.id !== splitInput?.id && supportsDirection(p.direction, 'out') && p.type === 'OPTICAL');
  const availableKinds = Object.entries(transferLabels).filter(([k]) => {
    if (k === 'splitter') return splitInput && splitOutputs.length >= 2;
    return (k !== 'control' && k !== 'digitalTx' && k !== 'digitalRx') || controlPairs.some(pair => pair.kind === k);
  });
  const activeKind = availableKinds.some(([k]) => k === kind) ? kind : 'rf';
  const parameters = draft.parameters ?? [];
  const byId = new Map(definitions.map(d => [d.id, d]));
  const occurrence = withMappedVoltages({ definition: draft, instancePath: [], parameters: readParameters(draft) }, byId);
  function updatePort(port: PortDefinition) {
    edit(prev => ({ ...prev, ports: prev.ports.map(p => p.id === port.id ? port : p) }));
    return true;
  }
  function finish() {
    try {
      const name = draft.name.trim();
      if (!name) throw new Error('请填写模板名称。');
      const root = body.current!;
      const forms = Array.from(root.querySelectorAll<HTMLFormElement>('form[data-parameter]'));
      const params = parameters.map((p, index) => {
        const form = forms[index];
        if (!form.reportValidity()) throw new Error('请检查参数「' + p.name + '」。');
        const value = readParameter(new FormData(form), 'value', p);
        if (!p.name.trim()) throw new Error('请填写参数名称。');
        if (p.kind === 'numeric' && typeof value === 'object' && value.kind === 'rfCurve') {
          const original = initial.parameters?.find(parameter => parameter.id === p.id);
          if (original?.kind !== 'numeric' || original.unit !== p.unit || JSON.stringify(original.defaultValue) !== JSON.stringify(value)) {
            const problem = curveProblem(value.points, p.unit, p.range);
            if (problem) throw new Error(`参数「${p.name}」：${problem}`);
          }
        }
        return p.kind === 'numeric' ? { ...p, defaultValue: typeof value === 'object' ? value : undefined }
          : { ...p, defaultValue: typeof value === 'string' ? value : undefined };
      });
      if (root.querySelector('.template-ports form :invalid')) throw new Error('请检查端口字段。');
      const portForms = root.querySelectorAll<HTMLFormElement>('.template-ports form');
      const ports = draft.ports.map((p, i) => readPort(new FormData(portForms[i]), p));
      const common = { name, ports, parameters: params };
      if (draft.kind === 'module') {
        if (draft.instances.some(i => !i.name.trim())) throw new Error('请填写子实例名称。');
        save({ ...draft, ...common });
      } else {
        const forms = Array.from(root.querySelectorAll<HTMLFormElement>('.template-transfer form'));
        const transfers = rows.map(({ transfer }, i) => {
          if (!forms[i].reportValidity()) throw new Error('请检查传输字段。');
          return readTransfer(new FormData(forms[i]), transfer);
        });
        const powerForm = root.querySelector<HTMLFormElement>('form[data-power]')!;
        if (!powerForm.reportValidity()) throw new Error('请检查直流电源与负载字段。');
        save({ ...draft, ...common, transfers, ...readPower(new FormData(powerForm)), switchStates: readSwitchStates(root) });
      }
    } catch (error) { report(projectErrorMessage(error)); }
  }
  return <div ref={body}>
    <label>模板名称<input value={draft.name} onChange={e => edit({ ...draft, name: e.target.value })} /></label>
    <section className="template-ports"><h3>端口</h3>{draft.ports.map(p => <details key={p.id}>
      <summary>{portDisplayName(p, false, draft.ports, occurrence)}</summary>
      <PortFields port={p} occurrence={occurrence} newPort={!initial.ports.some(port => port.id === p.id)}
        save={updatePort} remove={() => edit({ ...draft,
        ports: draft.ports.filter(other => other.id !== p.id),
        ...(draft.kind === 'module' && { portMappings: draft.portMappings?.filter(m => m.portId !== p.id) }) })} />
    </details>)}<button onClick={() => edit({ ...draft, ports: [...draft.ports, {
      id: crypto.randomUUID(), name: '端口 ' + (draft.ports.length + 1), type: 'RF', direction: 'in',
    }] })}>添加端口</button></section>
    <section><h3>参数定义</h3>{parameters.map(p => <details key={p.id}><summary>{p.name || '新参数'}</summary>
      <TemplateParameter parameter={p} change={param => edit({ ...draft, parameters: parameters.map(other => other.id === p.id ? param : other) })}
        remove={() => edit({ ...draft, parameters: parameters.filter(other => other.id !== p.id) })} />
    </details>)}<button onClick={() => edit({ ...draft, parameters: [...parameters, { id: crypto.randomUUID(), name: '新参数',
      kind: 'numeric', unit: 'dB', valueKind: 'fixed', overridable: true }] })}>添加参数</button></section>
    {draft.kind === 'module' ? <TemplateModule occurrence={occurrence} module={draft} definitions={definitions} hidden={hidden} change={edit} /> : <section><h3>传输关系</h3>
      {rows.map(({ key, transfer }) => <details key={key} className="template-transfer" onChange={event => {
        const select = event.target;
        if (!(select instanceof HTMLSelectElement) || (select.name !== 'from' && select.name !== 'to')) return;
        const field = select.name === 'from' ? 'fromPortId' : 'toPortId';
        setRows(current => current.map(row => row.key === key ? { ...row, pair: { ...row.pair, [field]: select.value } } : row));
      }}><summary>{transferLabels[transfer.kind]}</summary>
        <TransferFields effective={occurrence.parameters} draft definition={draft} transfer={transfer} save={() => {}} />
        <button onClick={() => setRows(rows.filter(row => row.key !== key))}>删除传输</button>
      </details>)}
      <label>传输类型<select value={activeKind} onChange={e => setKind(e.target.value as Transfer['kind'])}>
        {availableKinds.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></label>
      <button onClick={() => {
        const kind = activeKind;
        const pair = controlPairs.find(pair => pair.kind === kind);
        const ports = pair ? { fromPortId: pair.fromPortId, toPortId: pair.toPortId } : {
          fromPortId: draft.ports.find(p => supportsDirection(p.direction, 'in') && p.type === transferTypes[kind][0])?.id ?? '',
          toPortId: kind === 'splitter' ? splitOutputs[0].id
            : draft.ports.find(p => supportsDirection(p.direction, 'out') && p.type === transferTypes[kind][1])?.id ?? '',
        };
        const transfer: Transfer = kind === 'wavelengthConversion' ? { kind, ...ports, fromChannelId: 'CWDM_1511', toChannelId: 'CWDM_1531' }
          : kind === 'splitter' ? { kind, ...ports, secondPortId: splitOutputs[1].id }
          : { kind, ...ports };
        setRows([...rows, { key: crypto.randomUUID(), transfer, pair: ports }]);
      }}>添加传输</button></section>}
    {draft.kind === 'component' && <><TemplatePower definition={draft} setSupply={enabled => {
      if (enabled && draft.ports.some(port => port.type === 'DC_POWER' && port.direction === 'out' && port.outputVoltageV?.kind === 'parameter')) {
        report('请先将直流输出端口的电压改为固定值或留空。');
        return;
      }
      edit({ ...draft, dcSupply: enabled || undefined,
        ports: enabled ? draft.ports : draft.ports.map(port => ({ ...port, supplyCapacity: undefined })) });
    }} /><TemplateSwitch definition={draft} /></>}
    <div className="actions"><button onClick={finish}>保存到器件库</button><button onClick={cancel}>取消草稿</button></div>
  </div>;
}
