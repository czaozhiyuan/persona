import { parameterValueKinds } from './parameters';
import { receiverModes } from './device';
import type { DcCapacity, DcValue, Transfer } from './device';
import type { EmpiricalValue, NumericUnit, ParameterDefinition } from './parameters';
import { isPowerPort, isSupplyOutput, supportsDirection } from './types';
import type { ComponentDefinition, PortDefinition, PortType } from './types';
import { validateChannelIds, validateEmpirical, validateRange } from './validate-parameters';
import { indexById, requireValid } from './validation';
import { validateWdm } from './wdm';

function validateDcValue(value: DcValue | undefined, unit: 'V' | 'A' | 'W' | 'ratio', parameters: ReadonlyMap<string, ParameterDefinition>, context: string) {
  if (value === undefined) return;
  const allowsRange = (min: number, max: number) => (unit === 'V' || unit === 'ratio' ? min > 0 : min >= 0)
    && (unit !== 'ratio' || max <= 1);
  if (value.kind === 'parameter') {
    const parameter = parameters.get(value.parameterId);
    requireValid(parameter?.kind === 'numeric' && parameter.unit === unit && parameter.valueKind === 'fixed',
      `${context}: 应引用单位为 ${unit} 的固定值参数`);
    requireValid(allowsRange(parameter.range?.min ?? -Infinity, parameter.range?.max ?? Infinity),
      `${context}: 参数范围必须限制在有效的供电取值内`);
  } else {
    validateEmpirical(value, ['fixed'], context);
    requireValid(allowsRange(value.value, value.value), `${context}: 无效的供电参数值`);
  }
}

function validateQuantity(
  parameters: ReadonlyMap<string, ParameterDefinition>, unit: NumericUnit,
  value: EmpiricalValue | { kind: 'parameter'; parameterId: string },
  kinds: readonly EmpiricalValue['kind'][], context: string, minimum?: number,
) {
  if (value.kind === 'parameter') {
    const parameter = parameters.get(value.parameterId);
    requireValid(parameter?.kind === 'numeric' && parameter.unit === unit && parameterValueKinds(parameter).every(kind => kinds.includes(kind)),
      `${context}: 无效的 ${unit} 参数引用「${value.parameterId}」`);
    if (minimum !== undefined) requireValid((parameter.range?.min ?? -Infinity) >= minimum,
      `${context}: 参数下限须至少为 ${minimum}`);
  } else {
    validateEmpirical(value, kinds, context, minimum === undefined ? undefined : { min: minimum });
  }
}

export function validatePortConstraints(port: PortDefinition, parameters: ReadonlyMap<string, ParameterDefinition>, context: string): void {
  requireValid(port.name === undefined || port.name.trim(), `${context}: 端口显示名称不能为空`);
  if (port.channelIds !== undefined) {
    requireValid(port.type === 'OPTICAL', `${context}: 仅光端口可以设置光通道 ID`);
    validateChannelIds(port.channelIds, context);
  }
  if (port.opticalEmitter) {
    requireValid(port.type === 'OPTICAL' && supportsDirection(port.direction, 'out'), `${context}: 光源必须声明在光输出端口`);
    if (port.opticalEmitter.powerDbm) validateQuantity(parameters, 'dBm', port.opticalEmitter.powerDbm, ['fixed', 'channelTable'], context);
  }
  if (port.inputRating) {
    const { unit } = port.inputRating;
    const compatible = isPowerPort(port.type) ? ['V', 'A', 'W'].includes(unit)
      : (port.type === 'OPTICAL' || port.type === 'RF') && unit === 'dBm';
    requireValid(supportsDirection(port.direction, 'in') && compatible, `${context}: 额定值单位或端口方向不匹配`);
    validateRange(port.inputRating, context);
  }
  if (port.inputVoltageV !== undefined) {
    requireValid(isPowerPort(port.type) && port.direction === 'in', `${context}: 仅供电输入端口可设置标称输入电压`);
    validateDcValue(port.inputVoltageV, 'V', parameters, `${context}的标称输入电压`);
  }
  validateDcValue(port.acLoadW, 'W', parameters, `${context}的交流负载功耗`);
  if (port.type === 'AC_POWER' && port.supplyCapacity !== undefined) {
    requireValid(port.supplyCapacity.unit === 'W' && port.supplyCapacity.value.kind === 'fixed', `${context}的交流额定容量须为固定 W 值`);
    validateDcValue(port.supplyCapacity.value, 'W', parameters, `${context}的额定容量`);
  }
  if (port.outputVoltageV !== undefined) {
    requireValid(isPowerPort(port.type) && port.direction === 'out', `${context}: 仅供电输出端口可设置输出电压`);
    validateDcValue(port.outputVoltageV, 'V', parameters, `${context}的输出电压`);
  }
}

export function channelSetsOverlap(a: PortDefinition, b: PortDefinition): boolean {
  return !a.channelIds || !b.channelIds || a.channelIds.some(id => b.channelIds?.includes(id));
}

export const transferTypes: Record<Transfer['kind'], readonly [PortType, PortType]> = {
  rf: ['RF', 'RF'], optical: ['OPTICAL', 'OPTICAL'], wavelengthConversion: ['OPTICAL', 'OPTICAL'],
  splitter: ['OPTICAL', 'OPTICAL'], digitalTx: ['CONTROL', 'OPTICAL'], digitalRx: ['OPTICAL', 'CONTROL'],
  eo: ['RF', 'OPTICAL'], dml: ['RF', 'OPTICAL'], oe: ['OPTICAL', 'RF'], dc: ['DC_POWER', 'DC_POWER'],
};

export function validateDevice(
  definition: ComponentDefinition, ports: ReadonlyMap<string, PortDefinition>,
  parameters: ReadonlyMap<string, ParameterDefinition>,
): void {
  if (definition.wdm) validateWdm(definition);
  function validateRoute(route: Transfer, context: string) {
    const from = ports.get(route.fromPortId);
    const to = ports.get(route.toPortId);
    const types = transferTypes[route.kind];
    requireValid(from && to && from.id !== to.id && supportsDirection(from.direction, 'in') && supportsDirection(to.direction, 'out')
      && from.type === types[0] && to.type === types[1], `${context}: 传输端口、类型或方向无效`);

    if (route.kind === 'wavelengthConversion') {
      // Input and output IDs can be equal, so validate each independently.
      validateChannelIds([route.fromChannelId], context);
      validateChannelIds([route.toChannelId], context);
      requireValid((!from.channelIds || from.channelIds.includes(route.fromChannelId))
        && (!to.channelIds || to.channelIds.includes(route.toChannelId)), `${context}: 传输端口不支持此光通道`);
    } else if ('channelIds' in route && route.channelIds !== undefined) {
      validateChannelIds(route.channelIds, context);
      requireValid(route.channelIds.every(id => (!from.channelIds || from.channelIds.includes(id))
        && (!to.channelIds || to.channelIds.includes(id))), `${context}: 传输端口不支持此光通道`);
    } else {
      requireValid(channelSetsOverlap(from, to), `${context}: 传输两端没有共同的光通道`);
    }

    if (route.kind === 'splitter') {
      const other = ports.get(route.secondPortId);
      requireValid(other?.type === 'OPTICAL' && supportsDirection(other.direction, 'out') && other.id !== to.id && other.id !== from.id
        && channelSetsOverlap(from, other), `${context}: 分路器需要两个不同且支持输入通道的光输出`);
      if (route.firstPercent) {
        validateQuantity(parameters, '%', route.firstPercent, ['fixed'], context, 0);
        const value = route.firstPercent;
        const parameter = value.kind === 'parameter' ? parameters.get(value.parameterId) : undefined;
        requireValid(value.kind === 'fixed' ? value.value <= 100 : parameter?.kind === 'numeric' && (parameter.range?.max ?? Infinity) <= 100,
          `${context}: 分光比上限为 100%`);
      }
      if (route.excessLossDb) validateQuantity(parameters, 'dB', route.excessLossDb, ['fixed'], context, 0);
      requireValid(!definition.transfers?.some(other => other !== route && other.fromPortId === from.id
        && [to.id, route.secondPortId].some(id => other.toPortId === id || (other.kind === 'splitter' && other.secondPortId === id))),
        `${context}: 分光输出不能重复配置传输`);
    }
    if (route.kind === 'digitalTx' || route.kind === 'digitalRx') {
      requireValid(!definition.transfers?.some(other => other !== route && other.fromPortId === from.id && other.toPortId === to.id),
        `${context}: 数字光端口对已有传输关系`);
    }
    if (route.kind === 'digitalRx') {
      for (const limit of [route.sensitivityDbm, route.overloadDbm]) {
        if (limit) validateQuantity(parameters, 'dBm', limit, ['fixed', 'channelTable'], context);
      }
    }
    if (route.kind === 'eo' && route.supplyPortId !== undefined) {
      const supply = ports.get(route.supplyPortId);
      requireValid(supply?.type === 'OPTICAL' && supportsDirection(supply.direction, 'in'), `${context}: 供光端口必须是光输入端口`);
      requireValid(channelSetsOverlap(supply, to) && (!route.channelIds || !supply.channelIds
        || route.channelIds.every(id => supply.channelIds?.includes(id))), `${context}: 供光通道不匹配`);
    }
    const kinds = route.kind === 'rf' ? ['fixed', 'rfCurve'] as const : ['fixed', 'channelTable'] as const;
    if ('gainDb' in route && route.gainDb !== undefined) validateQuantity(parameters, 'dB', route.gainDb, kinds, context);
    if (route.kind === 'optical' && route.insertionLossDb) {
      requireValid(!route.gainDb, `${context}: 光传输不能同时设置增益和插损`);
      validateQuantity(parameters, 'dB', route.insertionLossDb, kinds, `${context} 光插损`, 0);
    }
    if (route.kind === 'rf' && route.nfDb !== undefined) validateQuantity(parameters, 'dB', route.nfDb, kinds, `${context} NF`);
    if (route.kind === 'dml' && route.modulationSlope) {
      validateQuantity(parameters, 'W/V', route.modulationSlope, ['fixed', 'rfCurve'], `${context} K(f)`, 0);
    }
    if (route.kind === 'eo') {
      if (route.insertionLossDb) validateQuantity(parameters, 'dB', route.insertionLossDb, kinds, `${context} 最大透过插损`, 0);
      if (route.vPi) validateQuantity(parameters, 'V', route.vPi, ['fixed', 'rfCurve'], `${context} RF Vπ`, Number.MIN_VALUE);
    }
    if (route.kind === 'oe') {
      if (route.responsivity) validateQuantity(parameters, 'A/W', route.responsivity, kinds, context, 0);
      if (route.responseDb) validateQuantity(parameters, 'dB', route.responseDb, ['fixed', 'rfCurve'], context);
      if (route.loadedGain) validateQuantity(parameters, 'V/W', route.loadedGain, ['fixed', 'rfCurve'], context);
      if (typeof route.receiver === 'object') {
        const mode = parameters.get(route.receiver.parameterId);
        requireValid(mode?.kind === 'enum' && mode.options.every(option => receiverModes.some(value => value === option)),
          `${context}: 接收结构参数无效`);
      }
    }
    if (route.kind === 'dc') {
      validateDcValue(route.efficiency, 'ratio', parameters, `${context}的转换效率`);
      validateDcCapacity(route.capacity, `${context}的额定输出容量`);
      requireValid(!definition.dcSupply, `${context}: 直流电源输出端口不能同时作为变换器输出`);
    }
  }

  function validateDcCapacity(capacity: DcCapacity | undefined, context: string) {
    if (capacity === undefined) return;
    requireValid(capacity.unit === 'A' || capacity.unit === 'W', `${context}: 单位应为 A 或 W`);
    validateDcValue(capacity.value, capacity.unit, parameters, context);
  }

  requireValid(definition.dcSupply === undefined || typeof definition.dcSupply === 'boolean', `定义「${definition.id}」: 直流电源角色必须为布尔值`);
  for (const port of ports.values()) {
    if (!isSupplyOutput(definition, port)) continue;
    const context = `定义「${definition.id}」的供电输出端口「${port.id}」`;
    requireValid(!port.outputVoltageV || port.outputVoltageV.kind === 'fixed', `${context}: 请在端口直接设置输出电压`);
    requireValid(!port.supplyCapacity || port.supplyCapacity.value.kind === 'fixed', `${context}: 请在端口直接设置额定容量`);
    validateDcCapacity(port.supplyCapacity, `${context}的额定容量`);
  }
  if (definition.dcLoad) {
    const { portId, powerW } = definition.dcLoad;
    const port = ports.get(portId);
    const context = `定义「${definition.id}」的直流负载`;
    requireValid(port?.type === 'DC_POWER' && port.direction === 'in', `${context}: 应为直流供电输入端口`);
    validateDcValue(powerW, 'W', parameters, `${context}的功耗`);
  }

  for (const route of definition.transfers ?? []) {
    const context = `定义「${definition.id}」的传输「${route.fromPortId} → ${route.toPortId}」`;
    requireValid(!definition.switchStates || !['optical', 'wavelengthConversion', 'splitter'].includes(route.kind),
      `${context}: 光开关的光路由必须由开关状态决定`);
    validateRoute(route, context);
  }

  if (definition.switchStates === undefined) return;
  requireValid(definition.switchStates.length > 0, `光开关「${definition.id}」至少需要一个状态`);
  const states = indexById(definition.switchStates, `光开关「${definition.id}」的状态`);
  for (const state of states.values()) {
    const context = `光开关「${definition.id}」的状态「${state.id}」`;
    const pairs = new Set<string>();
    for (const route of state.routes) {
      validateRoute({ ...route, kind: 'optical' }, context);
      const key = JSON.stringify([route.fromPortId, route.toPortId]);
      requireValid(!pairs.has(key), `${context}: 重复的光路由 ${key}`);
      pairs.add(key);
    }
  }
}
