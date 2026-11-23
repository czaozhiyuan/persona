import { numberedNames } from '../../../model/v1/display-names';
import { createPathNames } from '../structure-scope';
import { portDisplayName } from '../labels';
import { createPathResolver } from '../../../engine/v1/path-resolver';
import { signalPortKey } from '../../../engine/v1/signal-graph';
import type { CableCoreRef, ConversionBoundary, LocalEndpointRef } from '../../../model/v1/topology';
import type { ConnectionRef, EndpointRef, InstancePath, Project } from '../../../model/v1/types';

export type Option<T> = { key: string; label: string; value: T };
type RequiredEdge = ConnectionRef | CableCoreRef;

export const requiredEdgeKey = (ref: RequiredEdge): string => JSON.stringify('bundleId' in ref
  ? [ref.scopePath, ref.bundleId, ref.coreId]
  : [ref.scopePath, ref.connectionId]);
export const conversionKey = ({ instancePath, fromPortId, toPortId }: ConversionBoundary): string =>
  JSON.stringify([instancePath, fromPortId, toPortId]);
export function createLinkOptions(project: Project) {
  const { graph, resolveNamedLink } = createPathResolver(project);
  const { showPath, showName } = createPathNames(graph.instances);
  const definitions = new Map(graph.instances.map(item => [JSON.stringify(item.instancePath), item.definition]));
  const showPort = (ref: EndpointRef) => {
    const ports = definitions.get(JSON.stringify(ref.instancePath))?.ports;
    const port = ports?.find(item => item.id === ref.portId);
    return port ? portDisplayName(port, false, ports) : '未找到的端口';
  };
  const showEndpoint = (ref: EndpointRef) => `${showPath(ref.instancePath)} / ${showPort(ref)}`;
  const endpoints: Option<EndpointRef>[] = [];
  const opticalEndpoints: Option<EndpointRef>[] = [];
  const opticalSources: Option<EndpointRef>[] = [];
  const via: Option<RequiredEdge>[] = [];
  const eo: Option<ConversionBoundary>[] = [];
  const oe: Option<ConversionBoundary>[] = [];
  for (const occurrence of graph.instances) {
    const { definition, instancePath } = occurrence;
    for (const port of definition.ports) {
      const ref = { instancePath, portId: port.id };
      const option = { key: signalPortKey(ref), label: showEndpoint(ref), value: ref };
      endpoints.push(option);
      if (port.type === 'OPTICAL') opticalEndpoints.push(option);
      if (port.type === 'OPTICAL' && port.direction === (definition.kind === 'component' ? 'out' : 'in')) {
        opticalSources.push(option);
      }
    }
    if (definition.kind === 'module') {
      const localEndpoint = ({ instanceId, portId }: LocalEndpointRef) => {
        const path = [...instancePath, instanceId];
        return `${showName(path)} · ${showPort({ instancePath: path, portId })}`;
      };
      for (const connection of definition.connections ?? []) {
        const value = { scopePath: instancePath, connectionId: connection.id };
        via.push({ key: requiredEdgeKey(value), value, label: `${showPath(instancePath)}：${localEndpoint(connection.from)} → ${localEndpoint(connection.to)}` });
      }
      for (const [index, bundle] of (definition.cableBundles ?? []).entries()) {
        for (const core of bundle.cores) {
          const value = { scopePath: instancePath, bundleId: bundle.id, coreId: core.id };
          via.push({ key: requiredEdgeKey(value), value, label: `${showPath(instancePath)} · 线缆 ${index + 1} · `
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
          label: `${showPath(instancePath)} · ${showPort({ instancePath, portId: value.fromPortId })} → ${showPort({ instancePath, portId: value.toPortId })}` });
      }
    }
  }
  const links = project.namedLinks ?? [];
  const labels = numberedNames(links.map(link => link.name));
  const namedLinks = links.map((link, index) => ({ value: link.id, label: labels[index] }));
  return { graph, showName, showPath, namedLinks, endpoints, opticalEndpoints, opticalSources, via, eo, oe, resolveNamedLink, showEndpoint, showPort };
}

export type LinkOptions = ReturnType<typeof createLinkOptions>;
