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
    : unavailable(unit, 'The budget value is not finite.');
}

export function addGain<Unit extends 'dB' | 'dBm'>(input: BudgetMetric<Unit>, gain: BudgetMetric<'dB'>): BudgetMetric<Unit> {
  if (input.availability === 'unavailable') return input;
  return gain.availability === 'available' ? budgetValue(input.unit, input.value + gain.value)
    : unavailable(input.unit, gain.reason);
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
      ? input.reason : `No input value in ${limits.unit} is available.` };
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
