import { useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { RfCurve } from '../../../model/v1/parameters';
import { validateEmpirical } from '../../../model/v1/validate-parameters';

export type CurvePointDraft = { id: string; frequency: string; gain: string };

const plot = { left: 68, right: 544, top: 20, bottom: 206 };
const ticks = [0, .25, .5, .75, 1];
const number = (value: string) => value.trim() ? Number(value) : NaN;
const plotValue = (value: number) => String(Number(Math.abs(value) > 1e12 ? value.toPrecision(4) : value.toFixed(2)));

export function readCalibrationCurve(draft: CurvePointDraft[]): RfCurve {
  const points = draft.map(({ frequency, gain }) => [number(frequency), number(gain)] as const)
    .sort(([a], [b]) => a - b);
  if (points.some(([frequency], index) => index > 0 && points[index - 1][0] === frequency)) {
    throw new Error('折点频率不能重复。');
  }
  const curve: RfCurve = { kind: 'rfCurve', points };
  validateEmpirical(curve, ['rfCurve'], '整段基准射频增益');
  return curve;
}

function chartBounds(points: { frequency: number; gain: number }[]) {
  let maxFrequency = 67;
  let minGain = -40;
  let maxGain = 10;
  for (const { frequency, gain } of points) {
    maxFrequency = Math.max(maxFrequency, frequency);
    minGain = Math.min(minGain, gain);
    maxGain = Math.max(maxGain, gain);
  }
  return { maxFrequency, minGain, maxGain };
}

export function CalibrationCurveEditor({ draft, onChange }: {
  draft: CurvePointDraft[];
  onChange: (points: CurvePointDraft[]) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [selectedId, setSelectedId] = useState(draft[0]?.id);
  const [pointNotice, setPointNotice] = useState('');
  const [drag, setDrag] = useState<{ id: string; pointer: number; bounds: ReturnType<typeof chartBounds> }>();
  const selected = draft.find(point => point.id === selectedId);
  const points = draft.map(point => ({ id: point.id, frequency: number(point.frequency), gain: number(point.gain) }))
    .filter(point => Number.isFinite(point.frequency) && point.frequency >= 0 && Number.isFinite(point.gain))
    .sort((a, b) => a.frequency - b.frequency);
  const bounds = drag?.bounds ?? chartBounds(points);
  const { maxFrequency, minGain, maxGain } = bounds;
  const gainScale = Math.max(Math.abs(minGain), maxGain);
  const low = minGain / gainScale;
  const high = maxGain / gainScale;
  const x = (frequency: number) => plot.left + frequency / maxFrequency * (plot.right - plot.left);
  const y = (gain: number) => plot.bottom - (gain / gainScale - low) / (high - low) * (plot.bottom - plot.top);
  const clamp = (fraction: number) => Math.max(0, Math.min(1, fraction));
  let error = '';
  try {
    readCalibrationCurve(draft);
  } catch (cause) {
    error = (cause as Error).message;
  }

  function pointerValues(event: PointerEvent) {
    const transform = svg.current?.getScreenCTM();
    if (!transform) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse());
    const fraction = clamp((plot.bottom - point.y) / (plot.bottom - plot.top));
    return {
      frequency: plotValue(clamp((point.x - plot.left) / (plot.right - plot.left)) * maxFrequency),
      gain: plotValue((low * (1 - fraction) + high * fraction) * gainScale),
    };
  }

  function update(id: string, change: Partial<Pick<CurvePointDraft, 'frequency' | 'gain'>>) {
    setPointNotice('');
    onChange(draft.map(point => point.id === id ? { ...point, ...change } : point));
  }

  function add(frequency: string, gain: string) {
    if (draft.some(point => number(point.frequency) === number(frequency))) {
      setPointNotice('该频率已有折点，请选择其他位置。');
      return;
    }
    const id = crypto.randomUUID();
    setPointNotice('');
    setSelectedId(id);
    onChange([...draft, { id, frequency, gain }]);
  }

  function addInLargestGap() {
    const ends = [0, ...points.map(point => point.frequency), maxFrequency];
    let start = 0;
    let width = 0;
    for (let index = 1; index < ends.length; index++) {
      const gap = ends[index] - ends[index - 1];
      if (gap > width) {
        width = gap;
        start = ends[index - 1];
      }
    }
    add(String(start + width / 2), selected?.gain || '-20');
  }

  function endDrag(event: PointerEvent<SVGSVGElement>) {
    if (drag?.pointer === event.pointerId) setDrag(undefined);
  }

  return <fieldset className="v1-calibration-curve">
    <legend>整段基准射频增益 (dB)</legend>
    <p className="v1-property-effective">点击图中空白处添加折点，拖动折点调整频率与增益。</p>
    <svg ref={svg} className="v1-calibration-plot" viewBox="0 0 564 250" aria-label="基准射频增益曲线"
      onPointerMove={event => {
        if (!drag || event.pointerId !== drag.pointer) return;
        const values = pointerValues(event);
        if (values) update(drag.id, values);
      }}
      onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
      <rect className="v1-calibration-plot-area" x={plot.left} y={plot.top} width={plot.right - plot.left} height={plot.bottom - plot.top}
        onPointerDown={event => {
          if (!event.isPrimary || event.button !== 0) return;
          const values = pointerValues(event);
          if (values) add(values.frequency, values.gain);
        }} />
      <g className="v1-calibration-axis">
        {ticks.map(fraction => {
          const frequency = fraction * maxFrequency;
          const gain = (low * (1 - fraction) + high * fraction) * gainScale;
          return <g key={fraction}>
            <line x1={x(frequency)} x2={x(frequency)} y1={plot.top} y2={plot.bottom} />
            <line x1={plot.left} x2={plot.right} y1={y(gain)} y2={y(gain)} />
            <text x={x(frequency)} y={plot.bottom + 16} textAnchor="middle">{plotValue(frequency)}</text>
            <text x={plot.left - 8} y={y(gain) + 4} textAnchor="end">{plotValue(gain)}</text>
          </g>;
        })}
        <text x={(plot.left + plot.right) / 2} y={242} textAnchor="middle">频率 (GHz)</text>
        <text transform="translate(14 113) rotate(-90)" textAnchor="middle">增益 (dB)</text>
      </g>
      <polyline className="v1-calibration-trace" points={points.map(point => `${x(point.frequency)},${y(point.gain)}`).join(' ')} />
      {points.map(point => <circle key={point.id} className="v1-calibration-point" cx={x(point.frequency)} cy={y(point.gain)} r={6}
        role="button" tabIndex={0} aria-pressed={selectedId === point.id} aria-label={`${point.frequency} GHz，${point.gain} dB`}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setSelectedId(point.id);
          }
        }}
        onPointerDown={event => {
          if (!event.isPrimary || event.button !== 0) return;
          setSelectedId(point.id);
          svg.current?.setPointerCapture(event.pointerId);
          setDrag({ id: point.id, pointer: event.pointerId, bounds });
        }} />)}
    </svg>
    <div>
      <button type="button" onClick={addInLargestGap}>添加折点</button>
      <button type="button" disabled={!selected} onClick={() => {
        const remaining = draft.filter(point => point.id !== selectedId);
        setSelectedId(remaining[0]?.id);
        setPointNotice('');
        onChange(remaining);
      }}>删除选中折点</button>
    </div>
    {selected && <div className="v1-property-pair">
      <label>折点频率 (GHz)<input type="number" step="any" value={selected.frequency}
        onChange={event => update(selected.id, { frequency: event.target.value })} /></label>
      <label>折点增益 (dB)<input type="number" step="any" value={selected.gain}
        onChange={event => update(selected.id, { gain: event.target.value })} /></label>
    </div>}
    {(error || pointNotice) && <p className="error" role="status">{error || pointNotice}</p>}
  </fieldset>;
}
