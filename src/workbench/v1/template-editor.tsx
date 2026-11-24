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
import { TemplateParameter } from './template-parameter';

export function TemplateEditor({ initial, definitions, hidden, save, cancel, report }: {
  initial: LibraryDefinition; definitions: LibraryDefinition[]; hidden: readonly string[]; save: (value: LibraryDefinition) => void;
  cancel: () => void; report: (message: string) => void;
}) {
  const [draft, edit] = useState(initial);
  const [rows, setRows] = useState(() => (initial.kind === 'component' ? initial.transfers ?? [] : [])
    .map(t => ({ key: crypto.randomUUID(), transfer: t })));
  const [kind, setKind] = useState<Transfer['kind']>('rf');
  const body = useRef<HTMLDivElement>(null);
  const parameters = draft.parameters ?? [];
  const occurrence = { definition: draft, instancePath: [], parameters: new Map() };
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
      <summary>{portDisplayName(p, false, draft.ports)}</summary>
      <PortFields port={p} occurrence={occurrence} save={updatePort} remove={() => edit({ ...draft,
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
    {draft.kind === 'module' ? <TemplateModule module={draft} definitions={definitions} hidden={hidden} change={edit} /> : <section><h3>传输关系</h3>
      {rows.map(({ key, transfer }) => <details key={key} className="template-transfer"><summary>{transferLabels[transfer.kind]}</summary>
        <TransferFields draft definition={draft} transfer={transfer} save={() => {}} />
        <button onClick={() => setRows(rows.filter(row => row.key !== key))}>删除传输</button>
      </details>)}
      <label>传输类型<select value={kind} onChange={e => setKind(e.target.value as Transfer['kind'])}>
        {Object.entries(transferLabels).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></label>
      <button onClick={() => {
        const ports = { fromPortId: draft.ports.find(p => p.direction === 'in')?.id ?? '',
          toPortId: draft.ports.find(p => p.direction === 'out')?.id ?? '' };
        const transfer: Transfer = kind === 'wavelengthConversion' ? { kind, ...ports, fromChannelId: 'CWDM_1511', toChannelId: 'CWDM_1531' }
          : { kind, ...ports };
        setRows([...rows, { key: crypto.randomUUID(), transfer }]);
      }}>添加传输</button></section>}
    {draft.kind === 'component' && <><TemplatePower definition={draft} /><TemplateSwitch definition={draft} /></>}
    <div className="actions"><button onClick={finish}>保存到器件库</button><button onClick={cancel}>取消草稿</button></div>
  </div>;
}
