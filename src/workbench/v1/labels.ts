import type { Transfer } from '../../model/v1/device';
import type { Connection } from '../../model/v1/topology';
export { editablePortName, portDisplayName, portTypeLabels } from '../../model/v1/display-names';

export const mediaLabels = {
  OPTICAL_FIBER: '光纤',
  RF_COAX: '射频同轴线',
  RJ45_CABLE: 'RJ45 线缆',
} satisfies Record<NonNullable<Connection['mediaKind']>, string>;

export const transferLabels = {
  rf: '射频传输',
  optical: '光传输',
  wavelengthConversion: '波长转换',
  eo: '电光转换',
  oe: '光电转换',
  dc: '直流变换',
} satisfies Record<Transfer['kind'], string>;
