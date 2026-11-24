import type { Transfer } from '../../model/v1/device';
import type { ComponentIconKey } from '../../model/v1/types';
import type { Connection } from '../../model/v1/topology';
export { editablePortName, portDisplayName, portTypeLabels } from '../../model/v1/display-names';

export const mediaLabels = {
  OPTICAL_FIBER: '光纤',
  RF_COAX: '射频同轴线',
  RJ45_CABLE: 'RJ45 线缆',
} satisfies Record<NonNullable<Connection['mediaKind']>, string>;

export const componentIconLabels = {
  laser: '激光器',
  dml: '直调激光器（DML）',
  multiWavelengthSource: '多波长光源',
  mzm: 'MZM 电光调制器',
  photodiode: 'PD / 光接收机',
  amplifier: 'RF 放大器',
  opticalAttenuator: '光衰减器',
  rfAttenuator: '射频衰减器',
  opticalSwitch: '光开关',
  dcSupply: '直流电源',
  dcConverter: 'DC/DC 变换器',
  controlCircuit: '控制电路', splitter: '光分路器', sfp: '数字光模块（SFP）',
} satisfies Record<ComponentIconKey, string>;

export const transferLabels = {
  rf: '射频传输',
  optical: '光传输',
  wavelengthConversion: '波长转换',
  eo: '电光转换',
  dml: '直调激光器电光转换',
  oe: '光电转换',
  dc: '直流变换', splitter: '互补分光（1×2）', digitalTx: '数字光发射', digitalRx: '数字光接收',
} satisfies Record<Transfer['kind'], string>;
