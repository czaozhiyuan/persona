import type { InputRating } from '../../model/v1/device';
import type { NumericUnit } from '../../model/v1/parameters';
import type { EndpointRef } from '../../model/v1/types';

export type BudgetMetric<Unit extends NumericUnit = NumericUnit> = { unit: Unit } & (
  | { availability: 'available'; value: number }
  | { availability: 'unavailable'; reason: string }
);

export function unavailable<Unit extends NumericUnit>(unit: Unit, reason: string): BudgetMetric<Unit> {
  return { unit, availability: 'unavailable', reason };
}

export function budgetValue<Unit extends NumericUnit>(unit: Unit, value: number): BudgetMetric<Unit> {
  return Number.isFinite(value) ? { unit, availability: 'available', value }
    : unavailable(unit, '预算结果不是有限数值。');
}

/** Exact linear zero expressed in logarithmic units. */
export function logZero<Unit extends 'dB' | 'dBm'>(unit: Unit): BudgetMetric<Unit> {
  return { unit, availability: 'available', value: -Infinity };
}

export function addGain<Unit extends 'dB' | 'dBm'>(input: BudgetMetric<Unit>, gain: BudgetMetric<'dB'>): BudgetMetric<Unit> {
  if (input.availability === 'unavailable') return input;
  if (gain.availability === 'unavailable') return unavailable(input.unit, gain.reason);
  if (input.value === -Infinity || gain.value === -Infinity) return logZero(input.unit);
  return budgetValue(input.unit, input.value + gain.value);
}

export type InputRatingCheck = { endpoint: EndpointRef; limits: InputRating } & (
  | { status: 'unknown'; reason: string }
  | { status: 'within_range'; value: number }
  | { status: 'below_min' | 'above_max'; value: number; excess: number }
);

/** Returns no check for an undeclared limit. An alarm does not change the calculated value. */
export function checkInputRating(endpoint: EndpointRef, limits: InputRating | undefined,
  input: BudgetMetric | undefined): InputRatingCheck | undefined {
  if (!limits) return;
  if (input?.unit !== limits.unit || input.availability !== 'available') {
    return { endpoint, limits, status: 'unknown', reason: input?.availability === 'unavailable' && input.unit === limits.unit
      ? input.reason : `缺少以 ${limits.unit} 为单位的输入值。` };
  }
  const { value } = input;
  if (limits.min !== undefined && value < limits.min) {
    return { endpoint, limits, status: 'below_min', value, excess: limits.min - value };
  }
  if (limits.max !== undefined && value > limits.max) {
    return { endpoint, limits, status: 'above_max', value, excess: value - limits.max };
  }
  return { endpoint, limits, status: 'within_range', value };
}
