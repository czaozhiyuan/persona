import { portDisplayName } from '../labels';
import { createPathResolver } from '../../../engine/v1/path-resolver';
import { signalPortKey } from '../../../engine/v1/signal-graph';
import type { CableCoreRef, ConversionBoundary } from '../../../model/v1/topology';
import type { ConnectionRef, EndpointRef, InstancePath, Project } from '../../../model/v1/types';

export type Option<T> = { key: string; label: string; value: T };
type RequiredEdge = ConnectionRef | CableCoreRef;

export const requiredEdgeKey = (ref: RequiredEdge): string => JSON.stringify('bundleId' in ref
  ? [ref.scopePath, ref.bundleId, ref.coreId]
  : [ref.scopePath, ref.connectionId]);
export const conversionKey = ({ instancePath, fromPortId, toPortId }: ConversionBoundary): string =>
  JSON.stringify([instancePath, fromPortId, toPortId]);
export const showPath = (path: InstancePath) => path.length ? path.join(' / ') : '系统根层级';
export const showEndpoint = (ref: EndpointRef) => `${showPath(ref.instancePath)} · ${portDisplayName(ref.portId, true)}`;

export function createLinkOptions(project: Project) {
  const { graph, resolveNamedLink } = createPathResolver(project);
  const endpoints: Option<EndpointRef>[] = [];
  const opticalEndpoints: Option<EndpointRef>[] = [];
  const opticalSources: Option<EndpointRef>[] = [];
  const via: Option<RequiredEdge>[] = [];
  const eo: Option<ConversionBoundary>[] = [];
  const oe: Option<ConversionBoundary>[] = [];
  for (const occurrence of graph.instances) {
    const { definition, instancePath, instance } = occurrence;
    for (const port of definition.ports) {
      const ref = { instancePath, portId: port.id };
      const option = { key: signalPortKey(ref), label: `${instance?.name ?? definition.name} · ${showEndpoint(ref)}`, value: ref };
      endpoints.push(option);
      if (port.type === 'OPTICAL') opticalEndpoints.push(option);
      if (port.type === 'OPTICAL' && port.direction === (definition.kind === 'component' ? 'out' : 'in')) {
        opticalSources.push(option);
      }
    }
    if (definition.kind === 'module') {
      for (const connection of definition.connections ?? []) {
        const value = { scopePath: instancePath, connectionId: connection.id };
        via.push({ key: requiredEdgeKey(value), value, label: `${showPath(instancePath)} · ${connection.id} · `
          + `${connection.from.instanceId}.${connection.from.portId} → ${connection.to.instanceId}.${connection.to.portId}` });
      }
      for (const bundle of definition.cableBundles ?? []) {
        for (const core of bundle.cores) {
          const value = { scopePath: instancePath, bundleId: bundle.id, coreId: core.id };
          via.push({ key: requiredEdgeKey(value), value, label: `${showPath(instancePath)} · ${bundle.id} / ${core.id} · `
            + `A:${core.a.pin} / B:${core.b.pin}${core.a.endpoint && core.b.endpoint ? '' : '（未接全）'}` });
        }
      }
    } else {
      for (const transfer of definition.transfers ?? []) {
        if (transfer.kind !== 'eo' && transfer.kind !== 'oe') continue;
        const value = { instancePath, fromPortId: transfer.fromPortId, toPortId: transfer.toPortId };
        const key = conversionKey(value);
        const options = transfer.kind === 'eo' ? eo : oe;
        if (!options.some(item => item.key === key)) options.push({ key, value,
          label: `${instance?.name ?? definition.name} · ${showPath(instancePath)} · ${portDisplayName(value.fromPortId, true)} → ${portDisplayName(value.toPortId, true)}` });
      }
    }
  }
  return { graph, endpoints, opticalEndpoints, opticalSources, via, eo, oe, resolveNamedLink };
}

export type LinkOptions = ReturnType<typeof createLinkOptions>;
