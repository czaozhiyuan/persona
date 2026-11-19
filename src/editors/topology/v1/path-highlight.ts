import type { PathResult } from '../../../engine/v1/path-resolver';
import { signalPortKey } from '../../../engine/v1/signal-graph';
import type { EndpointRef, InstancePath } from '../../../model/v1/types';

export const canvasEdgeKey = (kind: 'connection' | 'mapping' | 'core', id: string, coreId?: string) =>
  JSON.stringify(coreId === undefined ? [kind, id] : [kind, id, coreId]);

export function projectPathHighlight(result: PathResult | undefined, scope: InstancePath) {
  const edges = new Set<string>();
  const ports = new Set<string>();
  const folded = new Set<string>();
  const inScope = (path: InstancePath) => path.length >= scope.length && scope.every((id, index) => id === path[index]);
  const exactScope = (path: InstancePath) => path.length === scope.length && inScope(path);
  function markPort(ref: EndpointRef) {
    if (!inScope(ref.instancePath)) return;
    if (ref.instancePath.length <= scope.length + 1) ports.add(signalPortKey(ref));
    else folded.add(ref.instancePath[scope.length]);
  }
  const paths = [result?.trace, ...(result?.trace?.supplies.flatMap(supply => supply.status === 'resolved' ? [supply.path] : []) ?? [])];
  for (const path of paths) {
    for (const step of path?.steps ?? []) markPort(step.port.ref);
    for (const edge of path?.edges ?? []) {
      const source = edge.source;
      if (source.kind === 'connection' && exactScope(source.ref.scopePath)) edges.add(canvasEdgeKey('connection', source.ref.connectionId));
      if (source.kind === 'cableCore' && exactScope(source.ref.scopePath)) edges.add(canvasEdgeKey('core', source.ref.bundleId, source.ref.coreId));
      if (source.kind === 'portMapping' && exactScope(source.publicPort.instancePath)) edges.add(canvasEdgeKey('mapping', source.publicPort.portId));
    }
  }
  if (result && result.status !== 'resolved' && result.endpoint) markPort(result.endpoint);
  return { edges, ports, folded };
}
