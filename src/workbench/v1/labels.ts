import type { Transfer } from '../../model/v1/device';
import type { Connection } from '../../model/v1/topology';
import type { PortType } from '../../model/v1/types';

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

const commonPortLabels: Readonly<Record<string, string>> = {
  IN: '输入', OUT: '输出',
  RF_IN: '射频输入', RF_OUT: '射频输出',
  OPT_IN: '光输入', OPT_OUT: '光输出',
  MM_IN: '多模光输入', LASER_IN: '激光输入', SUPPLY: '供光输入',
  CONTROL_IN: '控制输入', CONTROL_OUT: '控制输出', CTRL: '控制端口',
  RETURN_IN: '回传输入', RETURN_OUT: '回传输出',
  IN_1371: '1371 nm 输入',
  IN_28: 'CH28 输入', IN_30: 'CH30 输入',
  OUT_28: 'CH28 输出', OUT_30: 'CH30 输出',
  OUT_A: 'A 路输出', OUT_B: 'B 路输出',
  TX_OUT: '发射光输出', RX_IN: '接收光输入',
  COMMON: '公共端口', TEST_OUT: '测试输出',
};

export function portDisplayName(id: string, includeId = false): string {
  if (!Object.hasOwn(commonPortLabels, id)) return id;
  const label = commonPortLabels[id];
  return includeId ? `${label}（${id}）` : label;
}
