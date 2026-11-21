import type { ConversionProfile, DcCapacity, DcValue, Transfer } from './device';
import type { EmpiricalValue, ParameterDefinition } from './parameters';
import type { ComponentDefinition, PortDefinition, PortType } from './types';
import { validateChannelIds, validateEmpirical, validateRange } from './validate-parameters';
import { indexById, requireValid } from './validation';

function validateDcValue(value: DcValue | undefined, unit: 'V' | 'A' | 'W' | 'ratio', parameters: ReadonlyMap<string, ParameterDefinition>, context: string) {
  if (value === undefined) return;
  const allowsRange = (min: number, max: number) => (unit === 'V' || unit === 'ratio' ? min > 0 : min >= 0)
    && (unit !== 'ratio' || max <= 1);
  if (value.kind === 'parameter') {
    const parameter = parameters.get(value.parameterId);
    requireValid(parameter?.kind === 'numeric' && parameter.unit === unit && parameter.valueKind === 'fixed',
      `${context}: 应引用单位为 ${unit} 的固定值参数`);
    requireValid(allowsRange(parameter.range?.min ?? -Infinity, parameter.range?.max ?? Infinity),
      `${context}: 参数范围必须限制在有效的直流取值内`);
  } else {
    validateEmpirical(value, ['fixed'], context);
    requireValid(allowsRange(value.value, value.value), `${context}: 无效的直流参数值`);
  }
}

export function validatePortConstraints(port: PortDefinition, parameters: ReadonlyMap<string, ParameterDefinition>, context: string): void {
  requireValid(port.name === undefined || port.name.trim(), `${context}: 端口显示名称不能为空`);
  if (port.channelIds !== undefined) {
    requireValid(port.type === 'OPTICAL', `${context}: 仅光端口可以设置光通道 ID`);
    validateChannelIds(port.channelIds, context);
  }
  if (port.inputRating) {
    const { unit } = port.inputRating;
    const compatible = port.type === 'DC_POWER' ? ['V', 'A', 'W'].includes(unit)
      : (port.type === 'OPTICAL' || port.type === 'RF') && unit === 'dBm';
    requireValid(port.direction === 'in' && compatible, `${context}: 额定值单位或端口方向不匹配`);
    validateRange(port.inputRating, context);
  }
  if (port.outputVoltageV !== undefined) {
    requireValid(port.type === 'DC_POWER' && port.direction === 'out', `${context}: 仅直流输出端口可设置输出电压`);
    validateDcValue(port.outputVoltageV, 'V', parameters, `${context}的输出电压`);
  }
}

export function channelSetsOverlap(a: PortDefinition, b: PortDefinition): boolean {
  return !a.channelIds || !b.channelIds || a.channelIds.some(id => b.channelIds?.includes(id));
}

const transferTypes: Record<Transfer['kind'], readonly [PortType, PortType]> = {
  rf: ['RF', 'RF'], optical: ['OPTICAL', 'OPTICAL'], wavelengthConversion: ['OPTICAL', 'OPTICAL'],
  eo: ['RF', 'OPTICAL'], oe: ['OPTICAL', 'RF'], dc: ['DC_POWER', 'DC_POWER'],
};

export function validateDevice(
  definition: ComponentDefinition, ports: ReadonlyMap<string, PortDefinition>,
  parameters: ReadonlyMap<string, ParameterDefinition>,
): void {
  function validateRoute(route: Transfer, context: string) {
    const from = ports.get(route.fromPortId);
    const to = ports.get(route.toPortId);
    const types = transferTypes[route.kind];
    requireValid(from?.direction === 'in' && to?.direction === 'out'
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

    if (route.kind === 'eo' && route.supplyPortId !== undefined) {
      const supply = ports.get(route.supplyPortId);
      requireValid(supply?.type === 'OPTICAL' && supply.direction === 'in', `${context}: 供光端口必须是光输入端口`);
      requireValid(channelSetsOverlap(supply, to) && (!route.channelIds || !supply.channelIds
        || route.channelIds.every(id => supply.channelIds?.includes(id))), `${context}: 供光通道不匹配`);
    }
    const kinds = route.kind === 'rf' ? ['fixed', 'rfCurve'] as const : ['fixed', 'channelTable'] as const;
    if ('gainDb' in route && route.gainDb !== undefined) validateDb(route.gainDb, kinds, context);
    if (route.kind === 'rf' && route.nfDb !== undefined) validateDb(route.nfDb, kinds, `${context} NF`);
    if (route.kind === 'eo' && route.opticalLoss !== undefined) {
      requireValid(route.gainDb === undefined, `${context}: 净增益和独立光损耗只能选一种方式设置`);
      const { intrinsicLossDb, operatingPointLossDb } = route.opticalLoss;
      if (intrinsicLossDb !== undefined) validateDb(intrinsicLossDb, kinds, `${context} 固有插损`, 0);
      if (operatingPointLossDb !== undefined) validateDb(operatingPointLossDb, kinds, `${context} 控制点附加损耗`, 0);
    }
    if (route.kind === 'dc') {
      validateDcValue(route.efficiency, 'ratio', parameters, `${context}的转换效率`);
      validateDcCapacity(route.capacity, `${context}的额定输出容量`);
      requireValid(route.toPortId !== definition.dcSupply?.portId, `${context}: 直流电源输出端口不能同时作为变换器输出`);
    }
  }

  function validateDcCapacity(capacity: DcCapacity | undefined, context: string) {
    if (capacity === undefined) return;
    requireValid(capacity.unit === 'A' || capacity.unit === 'W', `${context}: 单位应为 A 或 W`);
    validateDcValue(capacity.value, capacity.unit, parameters, context);
  }

  if (definition.dcSupply) {
    const { portId, capacity } = definition.dcSupply;
    const port = ports.get(portId);
    const context = `定义「${definition.id}」的直流电源`;
    requireValid(port?.type === 'DC_POWER' && port.direction === 'out', `${context}: 应为直流供电输出端口`);
    validateDcCapacity(capacity, `${context}的额定输出容量`);
  }
  if (definition.dcLoad) {
    const { portId, powerW } = definition.dcLoad;
    const port = ports.get(portId);
    const context = `定义「${definition.id}」的直流负载`;
    requireValid(port?.type === 'DC_POWER' && port.direction === 'in', `${context}: 应为直流供电输入端口`);
    validateDcValue(powerW, 'W', parameters, `${context}的功耗`);
  }

  function validateDb(
    value: EmpiricalValue | { kind: 'parameter'; parameterId: string },
    kinds: readonly EmpiricalValue['kind'][], context: string, minimum?: number,
  ) {
    if (value.kind === 'parameter') {
      const parameter = parameters.get(value.parameterId);
      requireValid(parameter?.kind === 'numeric' && parameter.unit === 'dB' && kinds.includes(parameter.valueKind),
        `${context}: 无效的 dB 参数引用「${value.parameterId}」`);
      if (minimum !== undefined) requireValid((parameter.range?.min ?? -Infinity) >= minimum,
        `${context}: 引用的损耗参数须有非负下限`);
    } else {
      validateEmpirical(value, kinds, context, minimum === undefined ? undefined : { min: minimum });
    }
  }

  for (const route of definition.transfers ?? []) {
    const context = `定义「${definition.id}」的传输「${route.fromPortId} → ${route.toPortId}」`;
    requireValid(!definition.switchStates || !['optical', 'wavelengthConversion'].includes(route.kind),
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

export function validateConversionProfile(profile: ConversionProfile): void {
  const context = `标定方案「${profile.id}」`;
  validateEmpirical(profile.rfGainRefDb, ['fixed', 'rfCurve'], context);
  requireValid(Number.isFinite(profile.pdPowerRefDbm) && (profile.k === undefined || Number.isFinite(profile.k)),
    `${context}: 参考功率和指定的经验系数 K 必须为有限数值`);
  if (profile.applicability?.channelIds) validateChannelIds(profile.applicability.channelIds, context);
}
