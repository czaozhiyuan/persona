import type { Transfer } from '../../model/v1/device';
import type { Connection } from '../../model/v1/topology';
import type { PortDefinition, PortType } from '../../model/v1/types';

export const portTypeLabels = {
  RF: '射频',
  OPTICAL: '光信号',
  DC_POWER: '直流供电',
  CONTROL: '控制',
} satisfies Record<PortType, string>;

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

export function portDisplayName({ id, name = id }: Pick<PortDefinition, 'id' | 'name'>, includeId = false): string {
  return includeId && name !== id ? `${name}（${id}）` : name;
}
