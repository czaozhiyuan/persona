import type { NumericParameter, NumericUnit, ParameterDefinition } from '../../model/v1/parameters';
import { ParameterField } from './properties/value-fields';

const units: NumericUnit[] = ['dB', 'dBm', 'V', 'A', 'W', 'GHz', 'nm', 'A/W', 'V/W', 'W/V', 'ohm', 'ratio', '%'];
const kinds = { fixed: '固定值', rfCurve: '射频曲线', channelTable: '通道表', rfValue: '固定值或射频曲线', opticalValue: '固定值或通道表' };

export function TemplateParameter({ parameter: p, change, remove }: {
  parameter: ParameterDefinition; change: (p: ParameterDefinition) => void; remove: () => void;
}) {
  return <fieldset><legend>{p.name || '新参数'}</legend>
    <form data-parameter={p.id} onSubmit={e => e.preventDefault()}>
      <label>参数名称<input value={p.name} required onChange={e => change({ ...p, name: e.target.value })} /></label>
      <label>参数类型<select value={p.kind} onChange={e => {
        const base = { id: p.id, name: p.name, overridable: p.overridable };
        change(e.target.value === 'enum' ? { ...base, kind: 'enum', options: ['选项一', '选项二'] }
          : { ...base, kind: 'numeric', unit: 'dB', valueKind: 'fixed' });
      }}><option value="numeric">数值</option><option value="enum">枚举</option></select></label>
      {p.kind === 'numeric' ? <>
        <label>单位<select value={p.unit} onChange={e => change({ ...p, unit: e.target.value as NumericUnit })}>
          {units.map(u => <option key={u}>{u}</option>)}</select></label>
        <label>允许取值<select value={p.valueKind} onChange={e => change({ ...p,
          valueKind: e.target.value as NumericParameter['valueKind'], defaultValue: undefined })}>
          {Object.entries(kinds).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></label>
        {(['min', 'max'] as const).map(k => <label key={k}>{k === 'min' ? '最小值' : '最大值'}
          <input type="number" step="any" defaultValue={p.range?.[k]} onChange={e => change({ ...p,
            range: { ...p.range, [k]: e.target.value === '' ? undefined : e.target.valueAsNumber } })} /></label>)}
      </> : <label>可选值（每行一个）<textarea value={p.options.join('\n')} onChange={e => change({ ...p, options: e.target.value.split('\n') })} /></label>}
      <ParameterField key={p.kind === 'numeric' ? p.valueKind : p.kind} parameter={p} value={p.defaultValue} label="模板默认值" />
      <label><input type="checkbox" checked={!!p.overridable} onChange={e => change({ ...p, overridable: e.target.checked })} />允许实例覆盖</label>
    </form><button onClick={remove}>删除参数</button>
  </fieldset>;
}
