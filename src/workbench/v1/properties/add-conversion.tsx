import { supportsDirection } from '../../../model/v1/types';
import { useState } from 'react';
import { isPowerPort } from '../../../model/v1/types';
import type { ComponentDefinition, PortDefinition } from '../../../model/v1/types';
import { portDisplayName } from '../labels';

type Candidate = { input: PortDefinition; outputs: PortDefinition[] };
type Conversion = { kind: 'eo' | 'dml' | 'oe' | 'digitalTx' | 'digitalRx'; fromPortId: string; toPortId: string };

export function conversionCandidates({ ports, transfers }: ComponentDefinition): Candidate[] {
  const candidates: Candidate[] = [];
  for (const input of ports) {
    if (!supportsDirection(input.direction, 'in') || isPowerPort(input.type)) continue;
    const outputs = ports.filter(port => supportsDirection(port.direction, 'out') &&
      (input.type === 'OPTICAL' ? port.type === 'RF' || port.type === 'CONTROL' : port.type === 'OPTICAL') &&
      !transfers?.some(transfer => transfer.fromPortId === input.id && transfer.toPortId === port.id));
    if (outputs.length) candidates.push({ input, outputs });
  }
  return candidates;
}

export function AddConversion({ definition, add }: { definition: ComponentDefinition; add: (conversion: Conversion) => void }) {
  const candidates = conversionCandidates(definition);
  if (!candidates.length) return null;
  const pairs = candidates.map(({ input, outputs }) => [input.id, input.type, outputs.map(port => [port.id, port.type])]);
  return <details>
    <summary>添加传输关系</summary>
    <ConversionForm key={JSON.stringify(pairs)} candidates={candidates} ports={definition.ports} add={add} />
  </details>;
}

function ConversionForm({ candidates, ports, add }: {
  candidates: Candidate[]; ports: readonly PortDefinition[]; add: (conversion: Conversion) => void;
}) {
  const [inputId, setInputId] = useState(candidates[0].input.id);
  const { input, outputs } = candidates.find(candidate => candidate.input.id === inputId)!;
  const options = (items: readonly PortDefinition[]) => items.map(port =>
    <option key={port.id} value={port.id}>{portDisplayName(port, true, ports)}</option>);
  return <form onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const output = outputs.find(port => port.id === data.get('output'));
    if (!output) return;
    const kind = input.type === 'CONTROL' ? 'digitalTx' : output.type === 'CONTROL' ? 'digitalRx'
      : input.type === 'OPTICAL' ? 'oe' : data.get('eoKind') === 'dml' ? 'dml' : 'eo';
    add({ fromPortId: input.id, toPortId: output.id, kind });
  }}>
    <label>转换输入<select name="input" value={inputId} onChange={event => setInputId(event.currentTarget.value)}>
      {options(candidates.map(candidate => candidate.input))}
    </select></label>
    <label>转换输出<select key={inputId} name="output">{options(outputs)}</select></label>
    {input.type === 'RF' && <label>电光转换方式<select name="eoKind">
      <option value="eo">外置调制器</option><option value="dml">直调激光器</option>
    </select></label>}
    <button type="submit">添加传输</button>
  </form>;
}
