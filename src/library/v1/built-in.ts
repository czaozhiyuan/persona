import { receiverModes } from '../../model/v1/device';
import { wdmPort, wdmTransfers } from '../../model/v1/wdm';
import type { NumericParameter } from '../../model/v1/parameters';
import type { ComponentDefinition, ModuleDefinition, PortDefinition } from '../../model/v1/types';

function port(id: string, name: string, type: PortDefinition['type'], direction: PortDefinition['direction']): PortDefinition {
  return { id, name, type, direction };
}

function numeric(id: string, name: string, unit: NumericParameter['unit'], range?: NumericParameter['range']): NumericParameter {
  return { id, name, unit, range, kind: 'numeric', valueKind: 'fixed', overridable: true };
}

const fixed = (value: number) => ({ kind: 'fixed' as const, value });
const parameter = (parameterId: string) => ({ kind: 'parameter' as const, parameterId });
const rfPorts = [port('RF_IN', '射频输入', 'RF', 'in'), port('RF_OUT', '射频输出', 'RF', 'out')];
const fiveVoltInput: PortDefinition = { id: 'DC_IN', type: 'DC_POWER', direction: 'in', inputVoltageV: { kind: 'fixed', value: 5 } };
const poweredRfPorts = [...rfPorts, fiveVoltInput];
const opticalPorts = [port('OPT_IN', '光输入', 'OPTICAL', 'in'), port('OPT_OUT', '光输出', 'OPTICAL', 'out')];
const dcOutput: PortDefinition = { id: 'DC_OUT', type: 'DC_POWER', direction: 'out', outputVoltageV: fixed(5) };
const wdmPorts: PortDefinition[] = [
  { id: 'COM', name: 'COM', type: 'OPTICAL', direction: 'bidirectional' },
  wdmPort('CH1', 'CWDM_1311', 'in'), wdmPort('CH2', 'CWDM_1351', 'in'),
  wdmPort('CH3', 'CWDM_1371', 'out'), wdmPort('CH4', 'CWDM_1391', 'out'),
];
const gain = numeric('gain', '增益', 'dB');
const attenuation = numeric('gain', '净增益（带符号）', 'dB', { max: 0 });
const insertionLoss = { ...numeric('loss', '插入损耗', 'dB', { min: 0 }), defaultValue: { kind: 'fixed', value: 1 } } as const;
const capacity = numeric('capacity', '额定输出功率', 'W', { min: 0 });

const emitter = { powerDbm: parameter('power') };
const laserPower = { ...numeric('power', '信号光输出功率', 'dBm'), valueKind: 'opticalValue', defaultValue: fixed(16) } as const;

export const blankComponentId = 'library-empty-component';
export const blankModuleId = 'library-empty-module';
export const blankEnclosureId = 'library-empty-enclosure';

export const isBlankTemplate = (id: string) => id === blankComponentId || id === blankModuleId || id === blankEnclosureId;

export const builtInDefinitions = [
  {
    kind: 'component', id: 'library-rf-gain', iconKey: 'amplifier', name: '射频增益器件（示例）', ports: poweredRfPorts,
    parameters: [{ ...gain, defaultValue: { kind: 'fixed', value: 6 } }],
    transfers: [{ kind: 'rf', fromPortId: 'RF_IN', toPortId: 'RF_OUT', gainDb: parameter('gain') }],
  },
  {
    kind: 'component', id: 'library-optical-source', iconKey: 'multiWavelengthSource', name: '双波长光源', ports: [
      { id: 'OPT_OUT', name: '光输出', type: 'OPTICAL', direction: 'out', opticalEmitter: emitter, channelIds: ['DWDM_CH28', 'DWDM_CH30'] }, fiveVoltInput,
    ], parameters: [laserPower],
  },
  {
    kind: 'module', id: 'library-rf-stage', name: '射频增益模块（示例）', ports: poweredRfPorts, parameters: [gain],
    instances: [{ id: 'amplifier', name: '内部增益器件', definitionId: 'library-rf-gain' }],
    portMappings: poweredRfPorts.map(port => ({ portId: port.id, target: { instanceId: 'amplifier', portId: port.id } })),
    parameterMappings: [{ parameterId: 'gain', target: { instanceId: 'amplifier', parameterId: 'gain' } }],
  },
  { kind: 'component', id: blankComponentId, name: '空白器件', ports: [] },
  { kind: 'module', id: blankModuleId, name: '空白模块', ports: [], instances: [] },
  { kind: 'module', id: blankEnclosureId, name: '空机箱', ports: [], instances: [],
    physicalEnclosure: { widthMm: 440, depthMm: 350, heightMm: 44.45 } },
  { kind: 'component', id: 'library-pcb', iconKey: 'controlCircuit', name: '控制电路', ports: [fiveVoltInput] },
  { kind: 'component', id: 'library-laser', iconKey: 'laser', name: '激光器', parameters: [laserPower],
    ports: [{ ...port('OPT_OUT', '光输出', 'OPTICAL', 'out'), opticalEmitter: emitter }, fiveVoltInput] },
  {
    kind: 'component', id: 'library-splitter', iconKey: 'splitter', name: '光分路器（1×2）',
    ports: [port('OPT_IN', '公共口', 'OPTICAL', 'bidirectional'),
      port('OPT_OUT_1', '支路 1', 'OPTICAL', 'bidirectional'), port('OPT_OUT_2', '支路 2', 'OPTICAL', 'bidirectional')],
    parameters: [
      { ...numeric('firstPercent', '支路 1 分光比', '%', { min: 0, max: 100 }), defaultValue: { kind: 'fixed', value: 50 } },
      { ...numeric('loss', '额外插损', 'dB', { min: 0 }), defaultValue: { kind: 'fixed', value: 0 } },
    ],
    transfers: [{ kind: 'splitter', fromPortId: 'OPT_IN', toPortId: 'OPT_OUT_1', secondPortId: 'OPT_OUT_2',
      firstPercent: parameter('firstPercent'), excessLossDb: parameter('loss') }],
  },
  {
    kind: 'component', id: 'library-sfp', iconKey: 'sfp', name: '数字光模块',
    ports: [port('DATA_TX_IN', 'TX', 'CONTROL', 'in'), { ...port('OPT_TX_OUT', 'OPT OUT', 'OPTICAL', 'out'), opticalEmitter: emitter },
      port('OPT_RX_IN', 'OPT IN', 'OPTICAL', 'in'), port('DATA_RX_OUT', 'RX', 'CONTROL', 'out'), fiveVoltInput],
    parameters: [ { ...laserPower, name: '发射光功率', defaultValue: fixed(0) },
      { ...numeric('sensitivity', '接收灵敏度', 'dBm'), valueKind: 'opticalValue', defaultValue: fixed(-20) },
      { ...numeric('overload', '接收过载上限（可选）', 'dBm'), valueKind: 'opticalValue', defaultValue: fixed(0) } ],
    transfers: [{ kind: 'digitalTx', fromPortId: 'DATA_TX_IN', toPortId: 'OPT_TX_OUT' },
      { kind: 'digitalRx', fromPortId: 'OPT_RX_IN', toPortId: 'DATA_RX_OUT',
        sensitivityDbm: parameter('sensitivity'), overloadDbm: parameter('overload') }],
  },
  {
    kind: 'component', id: 'library-dml', iconKey: 'dml', name: '直调激光器',
    ports: [rfPorts[0], { ...opticalPorts[1], opticalEmitter: emitter }, fiveVoltInput],
    parameters: [{ ...laserPower, name: '平均输出信号光功率 P0' },
      { ...numeric('slope', '加载 50 Ω 的直调系数 K(f)', 'W/V', { min: 0 }), valueKind: 'rfValue', defaultValue: fixed(0.01) }],
    transfers: [{ kind: 'dml', fromPortId: 'RF_IN', toPortId: 'OPT_OUT', modulationSlope: parameter('slope') }],
  },
  {
    kind: 'component', id: 'library-mzm', iconKey: 'mzm', name: '光调制器（MZM）',
    ports: [port('RF_IN', '射频输入', 'RF', 'in'), port('LASER_IN', '激光输入', 'OPTICAL', 'in'), port('OPT_OUT', '光输出', 'OPTICAL', 'out'), fiveVoltInput],
    parameters: [{ ...numeric('intrinsicLoss', '最大透过状态光插损', 'dB', { min: 0 }), valueKind: 'opticalValue', defaultValue: fixed(3) },
      { ...numeric('vPi', 'RF 半波电压 Vπ（固定值按平坦响应）', 'V', { min: Number.MIN_VALUE }), valueKind: 'rfValue', defaultValue: fixed(5) }],
    transfers: [{ kind: 'eo', fromPortId: 'RF_IN', toPortId: 'OPT_OUT', supplyPortId: 'LASER_IN',
      insertionLossDb: parameter('intrinsicLoss'), vPi: parameter('vPi') }],
  },
  {
    kind: 'component', id: 'library-pd', iconKey: 'photodiode', name: '光电探测器（PD）',
    ports: [port('OPT_IN', '光输入', 'OPTICAL', 'in'), port('RF_OUT', '射频输出', 'RF', 'out'), fiveVoltInput],
    parameters: [{ id: 'receiver', name: '外接 50 Ω 时的接收结构', kind: 'enum', options: receiverModes, overridable: true, defaultValue: 'external50' },
      { ...numeric('responsivity', '响应度', 'A/W', { min: 0 }), valueKind: 'opticalValue', defaultValue: fixed(0.8) }, { ...numeric('response', '无源 PD 归一化幅频响应（缺省平坦）', 'dB'), valueKind: 'rfValue', defaultValue: fixed(0) },
      { ...numeric('loadedGain', '有源接收机加载转换增益', 'V/W'), valueKind: 'rfValue' }],
    transfers: [{ kind: 'oe', fromPortId: 'OPT_IN', toPortId: 'RF_OUT', receiver: parameter('receiver'),
      responsivity: parameter('responsivity'), responseDb: parameter('response'), loadedGain: parameter('loadedGain') }],
  },
  {
    kind: 'component', id: 'library-optical-switch', iconKey: 'opticalSwitch', name: '光通断开关', ports: [...opticalPorts, fiveVoltInput],
    parameters: [{ ...attenuation, valueKind: 'opticalValue', defaultValue: fixed(-1) }],
    switchStates: [
      { id: 'pass', name: '导通', routes: [{ fromPortId: 'OPT_IN', toPortId: 'OPT_OUT', gainDb: parameter('gain') }] },
      { id: 'block', name: '阻断', routes: [] },
    ],
  },
  {
    kind: 'component', id: 'library-optical-attenuator', iconKey: 'opticalAttenuator', name: '光衰减器',
    ports: [port('OPT_IN', '光口 A', 'OPTICAL', 'bidirectional'), port('OPT_OUT', '光口 B', 'OPTICAL', 'bidirectional')],
    parameters: [{ ...attenuation, defaultValue: { kind: 'fixed', value: -3 } }],
    transfers: [{ kind: 'optical', fromPortId: 'OPT_IN', toPortId: 'OPT_OUT', gainDb: parameter('gain') },
      { kind: 'optical', fromPortId: 'OPT_OUT', toPortId: 'OPT_IN', gainDb: parameter('gain') }],
  },
  {
    kind: 'component', id: 'library-optical-amplifier', iconKey: 'opticalAmplifier', name: '光放大器', ports: [...opticalPorts, fiveVoltInput],
    parameters: [{ ...numeric('gain', '光增益', 'dB'), defaultValue: { kind: 'fixed', value: 5 } }],
    transfers: [{ kind: 'optical', fromPortId: 'OPT_IN', toPortId: 'OPT_OUT', gainDb: parameter('gain') }],
  },
  {
    kind: 'component', id: 'library-circulator', iconKey: 'circulator', name: '光环形器',
    ports: [port('P1', 'P1', 'OPTICAL', 'in'), port('P2', 'P2', 'OPTICAL', 'bidirectional'),
      port('P3', 'P3', 'OPTICAL', 'out')],
    parameters: [insertionLoss],
    transfers: [{ kind: 'optical', fromPortId: 'P1', toPortId: 'P2', insertionLossDb: parameter('loss') },
      { kind: 'optical', fromPortId: 'P2', toPortId: 'P3', insertionLossDb: parameter('loss') }],
  },
  {
    kind: 'component', id: 'library-isolator', iconKey: 'isolator', name: '光隔离器', ports: opticalPorts,
    parameters: [insertionLoss],
    transfers: [{ kind: 'optical', fromPortId: 'OPT_IN', toPortId: 'OPT_OUT', insertionLossDb: parameter('loss') }],
  },
  {
    kind: 'component', id: 'library-rf-amplifier', iconKey: 'amplifier', name: '射频放大器', ports: poweredRfPorts,
    parameters: [{ ...gain, valueKind: 'rfValue', defaultValue: fixed(5) },
      { ...numeric('nf', '噪声系数', 'dB', { min: 0 }), valueKind: 'rfValue', defaultValue: fixed(3) }],
    transfers: [{ kind: 'rf', fromPortId: 'RF_IN', toPortId: 'RF_OUT', gainDb: parameter('gain'), nfDb: parameter('nf') }],
  },
  {
    kind: 'component', id: 'library-rf-attenuator', iconKey: 'rfAttenuator', name: '射频衰减器', ports: rfPorts,
    parameters: [{ ...attenuation, valueKind: 'rfValue', defaultValue: fixed(-3) }],
    transfers: [{ kind: 'rf', fromPortId: 'RF_IN', toPortId: 'RF_OUT', gainDb: parameter('gain') }],
  },
  {
    kind: 'component', id: 'library-dc-supply', iconKey: 'dcSupply', name: 'AC/DC 电源',
    ports: [{ ...dcOutput, supplyCapacity: { unit: 'W', value: fixed(60) } },
      { id: 'AC_IN', type: 'AC_POWER', direction: 'in', inputVoltageV: { kind: 'fixed', value: 220 } }],
    dcSupply: true,
  },
  {
    kind: 'component', id: 'library-dc-converter', iconKey: 'dcConverter', name: 'DC/DC 变换器',
    ports: [port('DC_IN', '直流输入', 'DC_POWER', 'in'), dcOutput],
    parameters: [{ ...numeric('efficiency', '效率', 'ratio', { min: Number.MIN_VALUE, max: 1 }), defaultValue: fixed(0.9) },
      { ...capacity, defaultValue: fixed(10) }],
    transfers: [{ kind: 'dc', fromPortId: 'DC_IN', toPortId: 'DC_OUT',
      efficiency: parameter('efficiency'), capacity: { unit: 'W', value: parameter('capacity') } }],
  },
  {
    kind: 'component', id: 'library-wdm', name: '波分/解波分复用器（WDM）', ports: wdmPorts, wdm: true,
    parameters: [{ ...numeric('insertionLoss', '统一通道插损', 'dB', { min: 0 }), defaultValue: { kind: 'fixed', value: 1 } }],
    transfers: wdmTransfers(wdmPorts),
  },
] as const satisfies readonly (ComponentDefinition | ModuleDefinition)[];
