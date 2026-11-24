import { useId, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { NumericRange, NumericUnit } from '../../../model/v1/parameters';
import { curveAxis, curveProblem, flatCurve, graphValue, moveCurvePoint, withinRange } from './curve-graph';
import type { CurvePoints } from './curve-graph';
import './rf-curve-editor.css';

type Props = {
  title: string; scope: string; unit: NumericUnit; range?: NumericRange;
  source?: CurvePoints; fixed?: number; apply: (points: CurvePoints) => void; close: () => void;
};

export function RfCurveEditor({ title, scope, unit, range, source, fixed, apply, close }: Props) {
  const titleId = useId();
  const db = unit === 'dB';
  const noDbGrid = db && Math.ceil(Math.max(-20, range?.min ?? -20) * 2) > Math.floor(Math.min(20, range?.max ?? 20) * 2);
  const originalProblem = source && curveProblem(source, unit, range);
  const [reviewOriginal, setReviewOriginal] = useState(!!originalProblem);
  const [points, setPoints] = useState<CurvePoints>(() => source && !originalProblem ? source
    : db ? flatCurve(0) : fixed !== undefined ? flatCurve(fixed) : []);
  const [axis, setAxis] = useState(() => curveAxis(unit, points.length ? points : flatCurve(1), range));
  const [start, setStart] = useState('');
  const [selected, select] = useState(0);
  const [exact, setExact] = useState<string>();
  const drag = useRef<number>(undefined);
  const point = points[selected];
  const problem = points.length ? curveProblem(points, unit, range) : undefined;
  const removable = selected > 0 && selected < points.length - 1;
  const yPercent = (y: number) => 100 * (axis.max - y) / (axis.max - axis.min);
  const validStart = !!start.trim() && withinRange(Number(start), range);
  const validExact = exact !== undefined && !!exact.trim() && withinRange(Number(exact), range);

  function reset(value: number) {
    const next = flatCurve(value);
    setPoints(next); setAxis(curveAxis(unit, next, range)); select(0); setExact(undefined); setReviewOriginal(false);
  }

  function remove() {
    if (!removable) return;
    setPoints(points.filter((_, i) => i !== selected)); select(selected - 1); setExact(undefined);
  }

  function coords(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(67, Math.round((event.clientX - rect.left) * 67 / rect.width)));
    const raw = axis.max - (event.clientY - rect.top) * (axis.max - axis.min) / rect.height;
    return { x, y: graphValue(raw, axis, unit, range) };
  }

  function press(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || !event.isPrimary || !points.length) return;
    event.preventDefault();
    event.currentTarget.focus();
    setExact(undefined);
    const handle = (event.target as Element).closest('[data-curve-point]');
    if (handle) {
      const index = Number(handle.getAttribute('data-curve-point'));
      select(index); drag.current = index; event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const { x, y } = coords(event);
    const index = points.findIndex(p => p[0] >= x);
    select(index);
    if (points[index][0] !== x) setPoints([...points.slice(0, index), [x, y], ...points.slice(index)]);
  }

  function setPointValue(value: number) {
    const next = moveCurvePoint(points, selected, point[0], value);
    setPoints(next);
    if (value < axis.min || value > axis.max) setAxis(curveAxis(unit, next, range));
    setExact(undefined);
  }

  return createPortal(<dialog className="v1-curve-dialog" aria-labelledby={titleId}
    ref={node => { if (node && !node.open) node.showModal(); }}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }}
    onBlur={event => event.stopPropagation()} onFocus={event => event.stopPropagation()}
    onChange={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Delete' && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); remove(); }
    }}>
    <header><div><h2 id={titleId}>{title} · {unit}</h2><p>{scope}</p></div>
      <button type="button" aria-label="关闭曲线编辑器" onClick={close}>×</button></header>
    {reviewOriginal ? <section className="v1-curve-original">
      <p>{originalProblem} 原始折点保留如下，重新建立后可编辑。</p>
      <pre>{source?.map(([x, y]) => `${x} GHz，${y} ${unit}`).join('\n')}</pre>
      <button type="button" disabled={noDbGrid} onClick={() => { if (db) reset(0); else { setPoints([]); setReviewOriginal(false); } }}>重新建立曲线</button>
    </section> : noDbGrid ? <p role="alert">字段范围内没有可用的 −20 至 +20 dB、0.5 dB 网格值。</p> : <>
      <div className="v1-curve-meta">
        <span>单击添加折点，拖动调整</span>
        <span>频率步进 1 GHz{points.length > 0 && ` · 数值步进 ${axis.step} ${unit}`}</span>
        {(range?.min !== undefined || range?.max !== undefined) && <span>字段范围 {range?.min === Number.MIN_VALUE ? '> 0'
          : `${range?.min ?? '−∞'} 至 ${range?.max ?? '+∞'}`} {unit}</span>}
      </div>
      {!points.length ? <div className="v1-curve-start">
        <label>起始值 ({unit})<input type="number" step="any" value={start} onChange={e => setStart(e.target.value)} /></label>
        <button type="button" disabled={!validStart} onClick={() => reset(Number(start))}>建立曲线</button>
      </div> : <>
        <div className="v1-curve-chart">
          <span className="v1-curve-unit">{unit}</span>
          <svg role="group" aria-label="射频曲线绘图区" tabIndex={0}
            onPointerDown={press} onLostPointerCapture={() => { drag.current = undefined; }}
            onPointerMove={event => {
              const index = drag.current;
              if (index === undefined || !event.isPrimary) return;
              const { x, y } = coords(event);
              setPoints(current => moveCurvePoint(current, index, x, y));
            }}>
            <rect width="100%" height="100%" className="v1-curve-paper" />
            {[0, 10, 20, 30, 40, 50, 60, 67].map(x => <g key={x}>
              <line x1={x / 67 * 100 + '%'} x2={x / 67 * 100 + '%'} y2="100%" />
              <text x={x / 67 * 100 + '%'} y="100%" dy="20" textAnchor="middle">{x}</text>
            </g>)}
            {Array.from({ length: 9 }, (_, i) => {
              const y = axis.max - (axis.max - axis.min) * i / 8;
              return <g key={i}><line y1={i * 12.5 + '%'} y2={i * 12.5 + '%'} x2="100%" className={db && i === 4 ? 'v1-curve-zero' : undefined} />
                {i % 2 === 0 && <text x="-9" y={i * 12.5 + '%'} dy="4" textAnchor="end">{db && y > 0 ? '+' : ''}{Number(y.toPrecision(6))}</text>}</g>;
            })}
            <svg width="100%" height="100%" viewBox="0 0 67 100" preserveAspectRatio="none" className="v1-curve-line">
              <polyline vectorEffect="non-scaling-stroke" fill="none" points={points.map(([x, y]) => `${x},${yPercent(y)}`).join(' ')} />
            </svg>
            {points.map(([x, y], i) => <g key={i} data-curve-point={i} className={selected === i ? 'is-selected' : undefined}>
              <circle cx={x / 67 * 100 + '%'} cy={yPercent(y) + '%'} r="10" fill="transparent" />
              <circle cx={x / 67 * 100 + '%'} cy={yPercent(y) + '%'} r="5" className="v1-curve-dot" />
            </g>)}
          </svg>
          <span className="v1-curve-frequency">频率 (GHz)</span>
        </div>
        <div className="v1-curve-point">
          <label>当前折点<select value={selected} onChange={e => { select(Number(e.target.value)); setExact(undefined); }}>
            {points.map(([x, y], i) => <option key={i} value={i}>{x} GHz · {y} {unit}</option>)}
          </select></label>
          {!db && <><label>精确数值 ({unit})<input type="number" step="any" value={exact ?? point[1]} onChange={e => setExact(e.target.value)} /></label>
            <button type="button" disabled={!validExact} onClick={() => setPointValue(Number(exact))}>应用数值</button></>}
          <button type="button" disabled={!removable} onClick={remove}>删除折点</button>
          {db && <button type="button" onClick={() => reset(0)}>恢复平坦</button>}
        </div>
        {problem && <p role="alert">{problem}</p>}
      </>}
    </>}
    <footer><button type="button" onClick={close}>取消</button>
      <button type="button" className="primary" disabled={reviewOriginal || noDbGrid || !points.length || !!problem || exact !== undefined}
        onClick={() => apply(points)}>确定</button></footer>
  </dialog>, document.body);
}
