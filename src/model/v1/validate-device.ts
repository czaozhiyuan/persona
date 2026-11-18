import type { ConversionProfile, Transfer } from './device';
import type { EmpiricalValue, ParameterDefinition } from './parameters';
import type { ComponentDefinition, PortDefinition, PortType } from './types';
import { validateChannelIds, validateEmpirical, validateRange } from './validate-parameters';
import { indexById, requireValid } from './validation';

export function validatePortConstraints(port: PortDefinition, context: string): void {
  if (port.channelIds !== undefined) {
    requireValid(port.type === 'OPTICAL', `${context}: only optical ports accept channel IDs`);
    validateChannelIds(port.channelIds, context);
  }
  if (port.inputRating) {
    const { unit } = port.inputRating;
    const compatible = port.type === 'DC_POWER' ? ['V', 'A', 'W'].includes(unit)
      : (port.type === 'OPTICAL' || port.type === 'RF') && unit === 'dBm';
    requireValid(port.direction === 'in' && compatible, `${context}: rating unit or port direction is incompatible`);
    validateRange(port.inputRating, context);
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
      && from.type === types[0] && to.type === types[1], `${context}: invalid route ports, types or directions`);

    if (route.kind === 'wavelengthConversion') {
      // Input and output IDs can be equal, so validate each independently.
      validateChannelIds([route.fromChannelId], context);
      validateChannelIds([route.toChannelId], context);
      requireValid((!from.channelIds || from.channelIds.includes(route.fromChannelId))
        && (!to.channelIds || to.channelIds.includes(route.toChannelId)), `${context}: channel disallowed at route port`);
    } else if ('channelIds' in route && route.channelIds !== undefined) {
      validateChannelIds(route.channelIds, context);
      requireValid(route.channelIds.every(id => (!from.channelIds || from.channelIds.includes(id))
        && (!to.channelIds || to.channelIds.includes(id))), `${context}: channel disallowed at route port`);
    } else {
      requireValid(channelSetsOverlap(from, to), `${context}: route ports have no shared optical channel`);
    }

    if (route.kind === 'eo' && route.supplyPortId !== undefined) {
      const supply = ports.get(route.supplyPortId);
      requireValid(supply?.type === 'OPTICAL' && supply.direction === 'in', `${context}: supply port must be an optical input`);
      requireValid(channelSetsOverlap(supply, to) && (!route.channelIds || !supply.channelIds
        || route.channelIds.every(id => supply.channelIds?.includes(id))), `${context}: optical supply channel mismatch`);
    }
    const kinds = route.kind === 'rf' ? ['fixed', 'rfCurve'] as const : ['fixed', 'channelTable'] as const;
    if ('gainDb' in route && route.gainDb !== undefined) validateDb(route.gainDb, kinds, context);
    if (route.kind === 'rf' && route.nfDb !== undefined) validateDb(route.nfDb, kinds, `${context} NF`);
  }

  function validateDb(
    value: EmpiricalValue | { kind: 'parameter'; parameterId: string },
    kinds: readonly EmpiricalValue['kind'][], context: string,
  ) {
    if (value.kind === 'parameter') {
      const parameter = parameters.get(value.parameterId);
      requireValid(parameter?.kind === 'numeric' && parameter.unit === 'dB' && kinds.includes(parameter.valueKind),
        `${context}: invalid dB parameter reference "${value.parameterId}"`);
    } else {
      validateEmpirical(value, kinds, context);
    }
  }

  for (const route of definition.transfers ?? []) {
    const context = `Transfer "${route.fromPortId}" → "${route.toPortId}" in "${definition.id}"`;
    requireValid(!definition.switchStates || !['optical', 'wavelengthConversion'].includes(route.kind),
      `${context}: optical switch routes must be state-dependent`);
    validateRoute(route, context);
  }

  if (definition.switchStates === undefined) return;
  requireValid(definition.switchStates.length > 0, `Switch "${definition.id}" must declare at least one state`);
  const states = indexById(definition.switchStates, `Switch states of "${definition.id}"`);
  for (const state of states.values()) {
    const context = `Switch "${definition.id}" state "${state.id}"`;
    const pairs = new Set<string>();
    for (const route of state.routes) {
      validateRoute({ ...route, kind: 'optical' }, context);
      const key = JSON.stringify([route.fromPortId, route.toPortId]);
      requireValid(!pairs.has(key), `${context}: duplicate optical route ${key}`);
      pairs.add(key);
    }
  }
}

export function validateConversionProfile(profile: ConversionProfile): void {
  const context = `Conversion profile "${profile.id}"`;
  validateEmpirical(profile.rfGainRefDb, ['fixed', 'rfCurve'], context);
  requireValid(Number.isFinite(profile.pdPowerRefDbm) && (profile.k === undefined || Number.isFinite(profile.k)),
    `${context}: reference power and any explicit k must be finite`);
  if (profile.applicability?.channelIds) validateChannelIds(profile.applicability.channelIds, context);
}
