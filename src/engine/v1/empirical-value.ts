import type { OpticalChannelId } from '../../model/v1/channels';
import type { EmpiricalValue, NumericUnit } from '../../model/v1/parameters';
import { budgetValue, unavailable } from './budget-metric';
import type { BudgetMetric } from './budget-metric';
import type { ResolvedInstance } from './hierarchy';

type ValueReference = EmpiricalValue | { kind: 'parameter'; parameterId: string };
type ValueQuery = { frequencyGHz?: number; channelId?: OpticalChannelId };

export function resolveEmpiricalValue<Unit extends NumericUnit>(unit: Unit, declaration: ValueReference | undefined,
  query: ValueQuery = {}, instance?: ResolvedInstance): BudgetMetric<Unit> {
  if (!declaration) return unavailable(unit, 'The empirical value is not declared.');
  let value: EmpiricalValue;
  if (declaration.kind === 'parameter') {
    const resolved = instance?.parameters.get(declaration.parameterId)?.value;
    if (!resolved || typeof resolved === 'string') {
      return unavailable(unit, `No effective numeric value is available for parameter "${declaration.parameterId}".`);
    }
    value = resolved;
  } else {
    value = declaration;
  }

  if (value.kind === 'fixed') return budgetValue(unit, value.value);
  if (value.kind === 'channelTable') {
    const { channelId } = query;
    if (channelId === undefined) return unavailable(unit, 'An optical channel is required.');
    const entry = value.values[channelId];
    return entry === undefined ? unavailable(unit, `No empirical value is defined for channel "${channelId}".`)
      : budgetValue(unit, entry);
  }

  const { frequencyGHz } = query;
  if (frequencyGHz === undefined || !Number.isFinite(frequencyGHz)) return unavailable(unit, 'A finite RF frequency is required.');
  const index = value.points.findIndex(([frequency]) => frequency >= frequencyGHz);
  if (index < 0 || frequencyGHz < value.points[0][0]) {
    return unavailable(unit, `Frequency ${frequencyGHz} GHz is outside the empirical curve.`);
  }
  const [rightX, rightY] = value.points[index];
  if (frequencyGHz === rightX) return budgetValue(unit, rightY);
  const [leftX, leftY] = value.points[index - 1];
  const fraction = (frequencyGHz - leftX) / (rightX - leftX);
  return budgetValue(unit, (1 - fraction) * leftY + fraction * rightY);
}
