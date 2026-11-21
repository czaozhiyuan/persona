import type { OpticalChannelId } from '../../model/v1/channels';
import type { EmpiricalValue, NumericUnit } from '../../model/v1/parameters';
import { budgetValue, unavailable } from './budget-metric';
import type { BudgetMetric } from './budget-metric';
import type { ResolvedInstance } from './hierarchy';

type ValueReference = EmpiricalValue | { kind: 'parameter'; parameterId: string };
type ValueQuery = { frequencyGHz?: number; channelId?: OpticalChannelId };

export function resolveEmpiricalValue<Unit extends NumericUnit>(unit: Unit, declaration: ValueReference | undefined,
  query: ValueQuery = {}, instance?: ResolvedInstance): BudgetMetric<Unit> {
  if (!declaration) return unavailable(unit, '未设置数值。');
  let value: EmpiricalValue;
  if (declaration.kind === 'parameter') {
    const resolved = instance?.parameters.get(declaration.parameterId)?.value;
    if (!resolved || typeof resolved === 'string') {
      return unavailable(unit, `参数「${declaration.parameterId}」没有有效数值。`);
    }
    value = resolved;
  } else {
    value = declaration;
  }

  if (value.kind === 'fixed') return budgetValue(unit, value.value);
  if (value.kind === 'channelTable') {
    const { channelId } = query;
    if (channelId === undefined) return unavailable(unit, '需要指定光通道。');
    const entry = value.values[channelId];
    return entry === undefined ? unavailable(unit, `通道「${channelId}」未设置数值。`)
      : budgetValue(unit, entry);
  }

  const { frequencyGHz } = query;
  if (frequencyGHz === undefined || !Number.isFinite(frequencyGHz)) return unavailable(unit, '需要指定有限的射频频率。');
  const index = value.points.findIndex(([frequency]) => frequency >= frequencyGHz);
  if (index < 0 || frequencyGHz < value.points[0][0]) {
    return unavailable(unit, `频率 ${frequencyGHz} GHz 超出曲线范围。`);
  }
  const [rightX, rightY] = value.points[index];
  if (frequencyGHz === rightX) return budgetValue(unit, rightY);
  const [leftX, leftY] = value.points[index - 1];
  const fraction = (frequencyGHz - leftX) / (rightX - leftX);
  return budgetValue(unit, (1 - fraction) * leftY + fraction * rightY);
}
