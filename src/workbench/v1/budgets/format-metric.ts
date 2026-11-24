import type { BudgetMetric } from '../../../engine/v1/budget-metric';

export function formatMetric(metric: BudgetMetric): string {
  if (metric.availability === 'unavailable') return '不可用';
  if (metric.value === -Infinity) return '−∞ ' + metric.unit;
  if (metric.unit === 'V' || metric.unit === 'A') {
    const magnitude = Math.abs(metric.value);
    const [scale, prefix] = magnitude === 0 || magnitude >= 1 ? [1, ''] as const
      : magnitude >= 0.001 ? [1e3, 'm'] as const : [1e6, 'µ'] as const;
    return Number((metric.value * scale).toPrecision(6)) + ' ' + prefix + metric.unit;
  }
  return metric.unit === 'ratio' ? `${(metric.value * 100).toFixed(1)}%` : `${metric.value.toFixed(1)} ${metric.unit}`;
}
