import type { BudgetMetric, InputRatingCheck } from '../../../engine/v1/budget-metric';
import './budget-reports.css';

export function Metric({ metric }: { metric?: BudgetMetric }) {
  if (!metric) return <>—</>;
  if (metric.availability === 'unavailable') {
    return <span className="v1-budget-unavailable" title={metric.reason}>不可用 · {metric.reason}</span>;
  }
  if (metric.value === -Infinity) return <>−∞ {metric.unit}{metric.unit === 'dBm' && '（无射频输出）'}</>;
  if (metric.unit === 'V' || metric.unit === 'A') {
    const magnitude = Math.abs(metric.value);
    const [scale, prefix] = magnitude === 0 || magnitude >= 1 ? [1, ''] as const
      : magnitude >= 0.001 ? [1e3, 'm'] as const : [1e6, 'µ'] as const;
    return <>{Number((metric.value * scale).toPrecision(6))} {prefix}{metric.unit}</>;
  }
  return <>{metric.unit === 'ratio' ? `${(metric.value * 100).toFixed(1)}%` : `${metric.value.toFixed(1)} ${metric.unit}`}</>;
}

export function Rating({ check, showStatus = false }: { check?: InputRatingCheck; showStatus?: boolean }) {
  if (!check) return <>{showStatus ? '未设置' : '—'}</>;
  if (check.status === 'within_range') return <>{showStatus ? '在额定范围内' : '—'}</>;
  if (check.status === 'unknown') return <>无法判断 · {check.reason}</>;
  if (check.value === -Infinity) return <strong className="v1-budget-warning">无射频输入 · 低于下限 {check.limits.min} {check.limits.unit}</strong>;
  return <strong className="v1-budget-warning">
    实际超限 · {check.status === 'above_max' ? '超出上限' : '低于下限'} {check.excess.toFixed(1)} {check.limits.unit}
  </strong>;
}
