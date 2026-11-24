import { receiverModes } from '../../model/v1/device';
import type { NumericParameter } from '../../model/v1/parameters';
import type { ComponentDefinition, ModuleDefinition, PortDefinition } from '../../model/v1/types';

function port(id: string, name: string, type: PortDefinition['type'], direction: PortDefinition['direction']): PortDefinition {
  return { id, name, type, direction };
}

function numeric(id: string, name: string, unit: NumericParameter['unit'], range?: NumericParameter['range']): NumericParameter {
  return { id, name, unit, range, kind: 'numeric', valueKind: 'fixed', overridable: true };
}

const parameter = (parameterId: string) => ({ kind: 'parameter' as const, parameterId });
const rfPorts = [port('RF_IN', '射频输入', 'RF', 'in'), port('RF_OUT', '射频输出', 'RF', 'out')];
const opticalPorts = [port('OPT_IN', '光输入', 'OPTICAL', 'in'), port('OPT_OUT', '光输出', 'OPTICAL', 'out')];
const dcPorts = [port('DC_IN', '直流输入', 'DC_POWER', 'in'), port('DC_OUT', '直流输出', 'DC_POWER', 'out')];
const gain = numeric('gain', '增益', 'dB');
const attenuation = numeric('gain', '净增益（带符号）', 'dB', { max: 0 });
const voltage = numeric('voltage', '输出电压', 'V', { min: Number.MIN_VALUE });
const capacity = numeric('capacity', '额定输出功率', 'W', { min: 0 });

const emitter = { powerDbm: parameter('power') };
const laserPower = { ...numeric('power', '信号光输出功率', 'dBm'), valueKind: 'opticalValue' } as const;

export const blankComponentId = 'library-empty-component';
export const blankModuleId = 'library-empty-module';
export const blankEnclosureId = 'library-empty-enclosure';

export const isBlankTemplate = (id: string) => id === blankComponentId || id === blankModuleId || id === blankEnclosureId;

export const builtInDefinitions = [
  {
    kind: 'component', id: 'library-rf-gain', iconKey: 'amplifier', name: '射频增益器件（示例）', ports: rfPorts,
    parameters: [{ ...gain, defaultValue: { kind: 'fixed', value: 6 } }],
    transfers: [{ kind: 'rf', fromPortId: 'RF_IN', toPortId: 'RF_OUT', gainDb: parameter('gain') }],
  },
  {
    kind: 'component', id: 'library-optical-source', iconKey: 'laser', name: '双通道光源', ports: [
      { id: 'OPT_OUT', name: '光输出', type: 'OPTICAL', direction: 'out', opticalEmitter: emitter, channelIds: ['DWDM_CH28', 'DWDM_CH30'] },
    ], parameters: [laserPower],
  },
  {
    kind: 'module', id: 'library-rf-stage', name: '射频增益模块（示例）', ports: rfPorts, parameters: [gain],
    instances: [{ id: 'amplifier', name: '内部增益器件', definitionId: 'library-rf-gain' }],
    portMappings: rfPorts.map(port => ({ portId: port.id, target: { instanceId: 'amplifier', portId: port.id } })),
    parameterMappings: [{ parameterId: 'gain', target: { instanceId: 'amplifier', parameterId: 'gain' } }],
  },
  { kind: 'component', id: blankComponentId, name: '空白器件', ports: [] },
  { kind: 'module', id: blankModuleId, name: '空白模块', ports: [], instances: [] },
  { kind: 'module', id: blankEnclosureId, name: '空机箱', ports: [], instances: [],
    physicalEnclosure: { widthMm: 440, depthMm: 350, heightMm: 44.45 } },
  { kind: 'component', id: 'library-pcb', iconKey: 'pcb', name: '电路板（PCB）', ports: [] },
  { kind: 'component', id: 'library-laser', iconKey: 'laser', name: '激光器', parameters: [laserPower],
    ports: [{ ...port('OPT_OUT', '光输出', 'OPTICAL', 'out'), opticalEmitter: emitter }] },
  {
    kind: 'component', id: 'library-mzm', iconKey: 'mzm', name: '调制器（MZM）',
    ports: [port('RF_IN', '射频输入', 'RF', 'in'), port('LASER_IN', '激光输入', 'OPTICAL', 'in'), port('OPT_OUT', '光输出', 'OPTICAL', 'out')],
    parameters: [{ ...numeric('intrinsicLoss', '最大透过状态光插损', 'dB', { min: 0 }), valueKind: 'opticalValue' },
      { ...numeric('vPi', 'RF 半波电压 Vπ（固定值按平坦响应）', 'V', { min: Number.MIN_VALUE }), valueKind: 'rfValue' }],
    transfers: [{ kind: 'eo', fromPortId: 'RF_IN', toPortId: 'OPT_OUT', supplyPortId: 'LASER_IN',
      insertionLossDb: parameter('intrinsicLoss'), vPi: parameter('vPi') }],
  },
  {
    kind: 'component', id: 'library-pd', iconKey: 'photodiode', name: '探测器（PD）',
    ports: [port('OPT_IN', '光输入', 'OPTICAL', 'in'), port('RF_OUT', '射频输出', 'RF', 'out')],
    parameters: [{ id: 'receiver', name: '外接 50 Ω 时的接收结构', kind: 'enum', options: receiverModes, overridable: true },
      { ...numeric('responsivity', '响应度', 'A/W', { min: 0 }), valueKind: 'opticalValue' }, { ...numeric('response', '无源 PD 归一化幅频响应（缺省平坦）', 'dB'), valueKind: 'rfValue' },
      { ...numeric('loadedGain', '有源接收机加载转换增益', 'V/W'), valueKind: 'rfValue' }],
    transfers: [{ kind: 'oe', fromPortId: 'OPT_IN', toPortId: 'RF_OUT', receiver: parameter('receiver'),
      responsivity: parameter('responsivity'), responseDb: parameter('response'), loadedGain: parameter('loadedGain') }],
  },
  {
    kind: 'component', id: 'library-optical-switch', iconKey: 'opticalSwitch', name: '光开关', ports: opticalPorts,
    parameters: [attenuation],
    switchStates: [
      { id: 'pass', name: '导通', routes: [{ fromPortId: 'OPT_IN', toPortId: 'OPT_OUT', gainDb: parameter('gain') }] },
      { id: 'block', name: '阻断', routes: [] },
    ],
  },
  {
    kind: 'component', id: 'library-optical-attenuator', iconKey: 'attenuator', name: '光衰减器', ports: opticalPorts,
    parameters: [attenuation],
    transfers: [{ kind: 'optical', fromPortId: 'OPT_IN', toPortId: 'OPT_OUT', gainDb: parameter('gain') }],
  },
  {
    kind: 'component', id: 'library-rf-amplifier', iconKey: 'amplifier', name: '射频放大器（RF）', ports: rfPorts,
    parameters: [gain, numeric('nf', '噪声系数', 'dB', { min: 0 })],
    transfers: [{ kind: 'rf', fromPortId: 'RF_IN', toPortId: 'RF_OUT', gainDb: parameter('gain'), nfDb: parameter('nf') }],
  },
  {
    kind: 'component', id: 'library-rf-attenuator', iconKey: 'attenuator', name: '射频衰减器（RF）', ports: rfPorts,
    parameters: [attenuation],
    transfers: [{ kind: 'rf', fromPortId: 'RF_IN', toPortId: 'RF_OUT', gainDb: parameter('gain') }],
  },
  {
    kind: 'component', id: 'library-dc-supply', iconKey: 'dcSupply', name: '直流电源', ports: [{ ...dcPorts[1], outputVoltageV: parameter('voltage') }],
    parameters: [voltage, capacity],
    dcSupply: { portId: 'DC_OUT', capacity: { unit: 'W', value: parameter('capacity') } },
  },
  {
    kind: 'component', id: 'library-dc-converter', iconKey: 'dcConverter', name: '直流变换器（DC/DC）',
    ports: [dcPorts[0], { ...dcPorts[1], outputVoltageV: parameter('voltage') }],
    parameters: [voltage, numeric('efficiency', '效率', 'ratio', { min: Number.MIN_VALUE, max: 1 }), capacity],
    transfers: [{ kind: 'dc', fromPortId: 'DC_IN', toPortId: 'DC_OUT',
      efficiency: parameter('efficiency'), capacity: { unit: 'W', value: parameter('capacity') } }],
  },
] as const satisfies readonly (ComponentDefinition | ModuleDefinition)[];
