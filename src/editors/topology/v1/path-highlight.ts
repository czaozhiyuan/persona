import { localWireKey as canvasEdgeKey } from '../../../model/v1/wire-route';
import type { linkAnnotations } from './link-annotations';
import type { PathResult } from '../../../engine/v1/path-resolver';
import type { SignalEdge } from '../../../engine/v1/signal-graph';
import { portTypeLabels } from '../../../model/v1/display-names';
import { signalPortKey } from '../../../engine/v1/signal-graph';
import type { EndpointRef, InstancePath } from '../../../model/v1/types';

export { canvasEdgeKey };

export type BudgetHighlight = {
  annotations?: ReturnType<typeof linkAnnotations>;
  endpoints?: readonly EndpointRef[];
  edges?: readonly SignalEdge[];
};

export function projectPathHighlight(result: PathResult | undefined, scope: InstancePath, budget?: BudgetHighlight) {
  const edges = new Set<string>();
  const captions = new Map<string, string>();
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
  function markEdge(edge: SignalEdge) {
    const { source } = edge;
    let key: string | undefined;
    if (source.kind === 'connection' && exactScope(source.ref.scopePath)) key = canvasEdgeKey('connection', source.ref.connectionId);
    if (source.kind === 'cableCore' && exactScope(source.ref.scopePath)) key = canvasEdgeKey('core', source.ref.bundleId, source.ref.coreId);
    if (source.kind === 'portMapping' && exactScope(source.publicPort.instancePath)) key = canvasEdgeKey('mapping', source.publicPort.portId);
    if (!key) return;
    edges.add(key);
    if (budget?.annotations) {
      const caption = budget.annotations.ports.get(signalPortKey(edge.to.ref));
      const loss = budget.annotations.wireLoss.get(edge);
      captions.set(key, [caption ?? portTypeLabels[edge.to.definition.type], loss].filter(Boolean).join(' · '));
    }
  }
  for (const path of paths) {
    for (const step of path?.steps ?? []) markPort(step.port.ref);
    for (const edge of path?.edges ?? []) markEdge(edge);
  }
  if (result && result.status !== 'resolved') for (const edge of result.digitalAccess ?? []) {
    markPort(edge.from.ref); markPort(edge.to.ref); markEdge(edge);
  }
  budget?.endpoints?.forEach(markPort);
  budget?.edges?.forEach(markEdge);
  if (result && result.status !== 'resolved' && result.endpoint) markPort(result.endpoint);
  return { edges, ports, folded, captions };
}
