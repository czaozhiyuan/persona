import type { InstancePath, ModuleDefinition, WireRef } from './types';

export const localWireKey = (kind: WireRef['kind'], id: string, coreId?: string) =>
  JSON.stringify(coreId === undefined ? [kind, id] : [kind, id, coreId]);

export function wireRouteKey(path: InstancePath, wire: WireRef) {
  const key = wire.kind === 'core' ? localWireKey('core', wire.bundleId, wire.id) : localWireKey(wire.kind, wire.id);
  return JSON.stringify([path, key]);
}

/** Local endpoints identify whether an existing drawing still describes the same wire. */
export function wireEndpoints(module: ModuleDefinition, wire: WireRef) {
  if (wire.kind === 'mapping') {
    const mapping = module.portMappings?.find(m => m.portId === wire.id);
    return mapping && [mapping.target.instanceId, mapping.target.portId];
  }
  if (wire.kind === 'connection') {
    const c = module.connections?.find(c => c.id === wire.id);
    return c && [c.from.instanceId, c.from.portId, c.to.instanceId, c.to.portId];
  }
  const core = module.cableBundles?.find(b => b.id === wire.bundleId)?.cores.find(c => c.id === wire.id);
  const from = core?.a.endpoint;
  const to = core?.b.endpoint;
  return from && to ? [from.instanceId, from.portId, to.instanceId, to.portId] : undefined;
}
