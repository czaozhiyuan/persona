import { budgetValue, logZero, unavailable } from './budget-metric';
import type { BudgetMetric } from './budget-metric';

/** The measured slope refers to the loaded 50-ohm port and the optical output reference plane. */
export function dmlEmission(slope: BudgetMetric<'W/V'>, rfInput: BudgetMetric<'dBm'>, mean: BudgetMetric<'dBm'>) {
  const inputPeak = rfInput.availability === 'unavailable' ? unavailable('V', rfInput.reason)
    : budgetValue('V', Math.sqrt(100 * 10 ** ((rfInput.value - 30) / 10)));
  const opticalPeak = slope.availability === 'unavailable' ? unavailable('W', `直调系数 K：${slope.reason}`)
    : inputPeak.availability === 'unavailable' ? unavailable('W', inputPeak.reason)
    : budgetValue('W', slope.value * inputPeak.value);
  const modulationDepth = opticalPeak.availability === 'unavailable' ? unavailable('ratio', opticalPeak.reason)
    : mean.availability === 'unavailable' ? unavailable('ratio', `无法判断小信号范围，平均光功率 P0：${mean.reason}`)
    : budgetValue('ratio', opticalPeak.value / 10 ** ((mean.value - 30) / 10));
  return { slope, inputPeak, mean, opticalPeak, modulationDepth };
}

export function dmlReception(emission: ReturnType<typeof dmlEmission>, pathGain: BudgetMetric<'dB'>, response: BudgetMetric<'V/W'>) {
  const { slope, opticalPeak } = emission;
  const receivedPeak = opticalPeak.availability === 'unavailable' ? opticalPeak
    : pathGain.availability === 'unavailable' ? unavailable('W', pathGain.reason)
    : budgetValue('W', opticalPeak.value * 10 ** (pathGain.value / 10));
  const gain = slope.availability === 'unavailable' ? unavailable('dB', `直调系数 K：${slope.reason}`)
    : pathGain.availability === 'unavailable' ? pathGain
    : response.availability === 'unavailable' ? unavailable('dB', `光电转换：${response.reason}`)
    : slope.value === 0 || response.value === 0 ? logZero('dB')
    : budgetValue('dB', 20 * Math.log10(slope.value) + 2 * pathGain.value + 20 * Math.log10(Math.abs(response.value)));
  return { receivedPeak, gain };
}
