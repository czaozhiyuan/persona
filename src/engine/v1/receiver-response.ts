import { receiverModes } from '../../model/v1/device';
import type { Transfer } from '../../model/v1/device';
import { budgetValue, unavailable } from './budget-metric';
import type { BudgetMetric } from './budget-metric';
import { resolveEmpiricalValue } from './empirical-value';
import type { ResolvedInstance } from './hierarchy';

export type Detector = Extract<Transfer, { kind: 'oe' }>;

export function receiverMode(receiver: Detector['receiver'], detector?: ResolvedInstance) {
  const value = typeof receiver === 'object' ? detector?.parameters.get(receiver.parameterId)?.value : receiver;
  return receiverModes.find(mode => mode === value);
}

export function hasReceiverValue(value: Detector['responseDb'], detector?: ResolvedInstance) {
  return value?.kind === 'parameter' ? detector?.parameters.has(value.parameterId) === true : value !== undefined;
}

export function loadedResponse(pd: Detector, detector: ResolvedInstance | undefined, rho: BudgetMetric<'A/W'>,
  frequencyGHz?: number): BudgetMetric<'V/W'> {
  const mode = receiverMode(pd.receiver, detector);
  if (mode === 'active50') {
    const response = resolveEmpiricalValue('V/W', pd.loadedGain, { frequencyGHz }, detector);
    return response.availability === 'available' ? response : unavailable('V/W', `已加载转换增益 C(f)：${response.reason}`);
  }
  if (mode !== 'external50' && mode !== 'parallel50') return unavailable('V/W', '请设置接收结构。');
  if (rho.availability === 'unavailable') return unavailable('V/W', `响应度：${rho.reason}`);
  const response = hasReceiverValue(pd.responseDb, detector) ? resolveEmpiricalValue('dB', pd.responseDb, { frequencyGHz }, detector) : budgetValue('dB', 0);
  if (response.availability === 'unavailable') return unavailable('V/W', `归一化频响：${response.reason}`);
  return budgetValue('V/W', rho.value * (mode === 'external50' ? 50 : 25) * 10 ** (response.value / 20));
}
