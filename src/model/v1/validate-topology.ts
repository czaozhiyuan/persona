import type { ConversionProfile } from './device';
import type { Connection, ConversionBoundary, LocalEndpointRef, NamedLink } from './topology';
import type { ComponentDefinition, InstancePath, ModuleDefinition, PortDefinition, PortType } from './types';
import { channelSetsOverlap } from './validate-device';
import { validateChannelIds, validateEmpirical } from './validate-parameters';
import { indexById, requireValid } from './validation';

const mediaTypes: Record<NonNullable<Connection['mediaKind']>, PortType> = {
  OPTICAL_FIBER: 'OPTICAL', RF_COAX: 'RF', RJ45_CABLE: 'CONTROL',
};

export function validateModuleTopology(
  module: ModuleDefinition, resolvePort: (endpoint: LocalEndpointRef) => PortDefinition | undefined,
): void {
  const pairs = new Set<string>();
  const recordPair = (from: LocalEndpointRef, to: LocalEndpointRef, context: string) => {
    const key = JSON.stringify([from.instanceId, from.portId, to.instanceId, to.portId]);
    requireValid(!pairs.has(key), `${context}: duplicate connection between the same endpoints`);
    pairs.add(key);
  };
  for (const connection of indexById(module.connections ?? [], `Connections in "${module.id}"`).values()) {
    const context = `Connection "${connection.id}" in "${module.id}"`;
    const from = resolvePort(connection.from);
    const to = resolvePort(connection.to);
    requireValid(from && to, `${context}: endpoints must be ports of direct children`);
    requireValid(from.direction === 'out' && to.direction === 'in', `${context}: direction must be output to input`);
    requireValid(from.type === to.type, `${context}: endpoint types do not match`);
    requireValid(connection.mediaKind === undefined || mediaTypes[connection.mediaKind] === from.type,
      `${context}: media is incompatible with endpoint type`);
    requireValid(channelSetsOverlap(from, to), `${context}: endpoints have no shared optical channel`);
    recordPair(connection.from, connection.to, context);
  }

  for (const bundle of indexById(module.cableBundles ?? [], `Cable bundles in "${module.id}"`).values()) {
    const context = `Cable bundle "${bundle.id}" in "${module.id}"`;
    requireValid(Number.isSafeInteger(bundle.coreCount) && bundle.coreCount > 0, `${context}: invalid core count`);
    const pinsA = new Set<number>(), pinsB = new Set<number>();
    const attachments = new Set<string>();
    for (const core of indexById(bundle.cores, `${context} cores`).values()) {
      const coreContext = `${context}, core "${core.id}"`;
      for (const [side, pins] of [[core.a, pinsA], [core.b, pinsB]] as const) {
        requireValid(Number.isSafeInteger(side.pin) && side.pin >= 1 && side.pin <= bundle.coreCount,
          `${coreContext}: pin must be in 1–${bundle.coreCount}`);
        requireValid(!pins.has(side.pin), `${coreContext}: duplicate pin ${side.pin} on the same side`);
        pins.add(side.pin);
        if (side.endpoint) {
          const key = JSON.stringify([side.endpoint.instanceId, side.endpoint.portId]);
          requireValid(!attachments.has(key), `${coreContext}: optical port is already attached in this bundle`);
          attachments.add(key);
        }
      }
      const a = core.a.endpoint, b = core.b.endpoint;
      const portA = a && resolvePort(a), portB = b && resolvePort(b);
      requireValid((!a || portA?.type === 'OPTICAL') && (!b || portB?.type === 'OPTICAL'),
        `${coreContext}: attachments must be optical ports of direct children`);
      if (a && b && portA && portB) {
        requireValid(portA.direction !== portB.direction, `${coreContext}: fibre must join an output and an input`);
        requireValid(channelSetsOverlap(portA, portB), `${coreContext}: endpoints have no shared optical channel`);
        if (portA.direction === 'out') recordPair(a, b, coreContext);
        else recordPair(b, a, coreContext);
      }
    }
  }
}

export function validateNamedLinks(
  links: readonly NamedLink[], profiles: ReadonlyMap<string, ConversionProfile>,
  definitionAtPath: (path: InstancePath) => ComponentDefinition | ModuleDefinition | undefined,
): void {
  for (const link of indexById(links, 'Named links').values()) {
    const context = `Named link "${link.id}"`;
    if (link.channelId !== undefined) validateChannelIds([link.channelId], context);
    for (const [label, endpoint] of [['start', link.from], ['end', link.to]] as const) {
      if (endpoint) requireValid(
        definitionAtPath(endpoint.instancePath)?.ports.some(port => port.id === endpoint.portId),
        `${context}: invalid ${label} endpoint reference`,
      );
    }
    for (const ref of link.via ?? []) {
      const scope = definitionAtPath(ref.scopePath);
      requireValid(scope?.kind === 'module', `${context}: invalid connection scope`);
      if ('bundleId' in ref) {
        const bundle = scope.cableBundles?.find(item => item.id === ref.bundleId);
        requireValid(bundle?.cores.some(core => core.id === ref.coreId), `${context}: unknown required fibre core`);
      } else {
        requireValid(scope.connections?.some(connection => connection.id === ref.connectionId),
          `${context}: unknown required connection "${ref.connectionId}" in scope`);
      }
    }

    const boundaries = new Set<string>();
    for (const binding of indexById(link.conversionBindings ?? [], `${context} conversion bindings`).values()) {
      const bindingContext = `${context}, binding "${binding.id}"`;
      requireValid(profiles.has(binding.profileId), `${bindingContext}: unknown conversion profile "${binding.profileId}"`);
      const validateBoundary = (side: 'eo' | 'oe', boundary: ConversionBoundary) => {
        const definition = definitionAtPath(boundary.instancePath);
        requireValid(definition?.kind === 'component' && definition.transfers?.some(transfer =>
          transfer.kind === side && transfer.fromPortId === boundary.fromPortId && transfer.toPortId === boundary.toPortId),
        `${bindingContext}: invalid ${side.toUpperCase()} transfer boundary`);
        const key = JSON.stringify([side, boundary.instancePath, boundary.fromPortId, boundary.toPortId]);
        requireValid(!boundaries.has(key), `${bindingContext}: conversion boundary is already bound`);
        boundaries.add(key);
      };
      validateBoundary('eo', binding.eo);
      validateBoundary('oe', binding.oe);
      const { rfGainRefDb, pdPowerRefDbm, k } = binding.overrides ?? {};
      if (rfGainRefDb !== undefined) validateEmpirical(rfGainRefDb, ['fixed', 'rfCurve'], bindingContext);
      requireValid((pdPowerRefDbm === undefined || Number.isFinite(pdPowerRefDbm)) && (k === undefined || Number.isFinite(k)),
        `${bindingContext}: reference power and K overrides must be finite`);
    }
  }
}
