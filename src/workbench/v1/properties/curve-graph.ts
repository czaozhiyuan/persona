import type { NumericRange, NumericUnit, RfCurve } from '../../../model/v1/parameters';

export type CurvePoints = RfCurve['points'];
export type CurveAxis = { min: number; max: number; step: number };
export const flatCurve = (value: number): CurvePoints => [[0, value], [67, value]];
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function withinRange(value: number, range?: NumericRange) {
  return Number.isFinite(value) && value >= (range?.min ?? -Infinity) && value <= (range?.max ?? Infinity);
}

export function curveProblem(points: CurvePoints, unit: NumericUnit, range?: NumericRange) {
  const invalid = points.find(([x, y]) => !Number.isInteger(x) || x < 0 || x > 67 || !withinRange(y, range)
    || (unit === 'dB' && (Math.abs(y) > 20 || !Number.isInteger(y * 2))));
  if (invalid) return `折点（${invalid[0]} GHz，${invalid[1]} ${unit}）超出允许范围或不在编辑网格上。`;
  if (points[0]?.[0] !== 0 || points.at(-1)?.[0] !== 67) return '曲线未覆盖 0 和 67 GHz 两个端点。';
}

export function curveAxis(unit: NumericUnit, points: CurvePoints, range?: NumericRange): CurveAxis {
  if (unit === 'dB') return { min: -20, max: 20, step: 0.5 };
  const values = points.map(point => point[1]);
  const low = Math.min(...values), high = Math.max(...values);
  const padding = (high - low || Math.abs(high) || 1) / 2;
  let min = Math.max(range?.min ?? -Infinity, low - padding);
  let max = Math.min(range?.max ?? Infinity, high + padding);
  if (min === max) { min = low - padding; max = high + padding; }
  const step = 10 ** Math.floor(Math.log10((max - min) / 100)) || Number.MIN_VALUE;
  return { min, max, step };
}

export function graphValue(raw: number, axis: CurveAxis, unit: NumericUnit, range?: NumericRange) {
  const min = Math.max(axis.min, range?.min ?? -Infinity), max = Math.min(axis.max, range?.max ?? Infinity);
  if (unit === 'dB') return clamp(Math.round(raw * 2) / 2, Math.ceil(min * 2) / 2, Math.floor(max * 2) / 2);
  return clamp(Number((Math.round(raw / axis.step) * axis.step).toPrecision(15)), min, max);
}

export function moveCurvePoint(points: CurvePoints, index: number, frequency: number, value: number): CurvePoints {
  const x = index === 0 || index === points.length - 1 ? points[index][0]
    : clamp(Math.round(frequency), points[index - 1][0] + 1, points[index + 1][0] - 1);
  return points.map((p, i) => i === index ? [x, value] : p);
}
