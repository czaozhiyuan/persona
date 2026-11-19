import type { BudgetMetric, InputRatingCheck } from '../../../engine/v1/budget-metric';
import './budget-reports.css';

export function Metric({ metric }: { metric?: BudgetMetric }) {
  if (!metric) return <>—</>;
  if (metric.availability === 'unavailable') {
    return <span className="v1-budget-unavailable" title={metric.reason}>不可用 · {metric.reason}</span>;
  }
  return <>{metric.unit === 'ratio' ? `${(metric.value * 100).toFixed(1)}%` : `${metric.value.toFixed(1)} ${metric.unit}`}</>;
}

export function Rating({ check }: { check?: InputRatingCheck }) {
  if (!check || check.status === 'within_range') return <>—</>;
  if (check.status === 'unknown') return <>无法判断 · {check.reason}</>;
  return <strong className="v1-budget-warning">
    {check.status === 'above_max' ? '超出上限' : '低于下限'} {check.excess.toFixed(1)} {check.limits.unit}
  </strong>;
}
