import type { Edge, XYPosition } from '@xyflow/react';
import { portDisplayName } from '../../../workbench/v1/labels';
import type { LocalEndpointRef } from '../../../model/v1/topology';
import type { InstancePath, ModuleDefinition, PortType } from '../../../model/v1/types';
import { canConnect, mappingId } from '../../../model/v1/types';
import { wireArrow } from '../../../model/v1/display-names';
import type { WiringSelection } from '../../../state/v1/remove-topology-object';
import type { projectTopology, TopologyItem } from './topology-projection';
import { hierarchyKey } from './hierarchy-view';
import { canvasEdgeKey } from './path-highlight';
import type { projectPathHighlight } from './path-highlight';
import { wiringProblem } from './wiring-validation';
import type { CanvasPort } from './wiring-validation';

export const nodeId = (key: string) => encodeURIComponent(key);
export const handleId = (id: string, inner = false) => encodeURIComponent(JSON.stringify([id, inner]));
export const portKey = (node: string, handle?: string | null) => JSON.stringify([node, handle]);
type ScopedPort = CanvasPort & { module: ModuleDefinition; scope: InstancePath };
export type WiringEdge = Edge<{
  wire: WiringSelection;
  routePoint?: XYPosition;
  savePoint?: (point?: XYPosition) => void;
  scope: InstancePath;
  portType: PortType;
  caption?: string;
  powerLabels?: { reverse: boolean; text: string }[];
  fan?: { x: number; y: number };
}, 'signal'>;

function fanOffsets(edges: readonly WiringEdge[], keyFor: (edge: WiringEdge) => string) {
  const groups = new Map<string, string[]>();
  for (const edge of edges) {
    const key = keyFor(edge);
    const ids = groups.get(key) ?? [];
    if (!groups.has(key)) groups.set(key, ids);
    ids.push(edge.id);
  }
  const result = new Map<string, number>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const step = Math.min(14, 36 / (ids.length - 1));
    ids.sort().forEach((id, index) => result.set(id, (index - (ids.length - 1) / 2) * step));
  }
  return result;
}

export function scopedWiringProblem(a?: ScopedPort, b?: ScopedPort): string | undefined {
  if (!a || !b) return '请选择两个不同的端口。';
  if (hierarchyKey(a.scope) !== hierarchyKey(b.scope)) return '不能直接跨层接线，请使用模块对外端口及其内部映射。';
  return wiringProblem(a.module, a, b);
}

export function projectWiring(projection: ReturnType<typeof projectTopology>,
  highlights: ReadonlyMap<string, ReturnType<typeof projectPathHighlight>>) {
  const ports = new Map<string, ScopedPort>();
  const edges: WiringEdge[] = [];
  for (const [key, { definition, path, members }] of projection.scopes) {
    append(definition, path, key, members, !!projection.nodeByKey.get(key)?.frame);
  }

  const pairs = fanOffsets(edges, edge => JSON.stringify([edge.source, edge.target].sort()));
  const sources = fanOffsets(edges, edge => portKey(edge.source, edge.sourceHandle));
  const targets = fanOffsets(edges, edge => portKey(edge.target, edge.targetHandle));
  for (const edge of edges) {
    const lane = pairs.get(edge.id);
    const x = lane ?? sources.get(edge.id) ?? 0;
    const y = lane ?? targets.get(edge.id) ?? 0;
    if (edge.data && (x || y)) edge.data.fan = { x, y };
  }

  function append(module: ModuleDefinition, scope: InstancePath, key: string, members: readonly TopologyItem[], hasFrame: boolean) {
    const highlighted = highlights.get(key)?.edges;
    const boundary = nodeId(key);
    const children = new Map(members.map(member => [member.item.instance!.id, member]));
    const child = (id: string) => nodeId(children.get(id)!.key);
    const childPort = ({ instanceId, portId }: LocalEndpointRef) => children.get(instanceId)!.item.definition.ports.find(port => port.id === portId)!;
    const childLabel = (ref: LocalEndpointRef) => {
      const occurrence = children.get(ref.instanceId)!.item;
      return portDisplayName(childPort(ref), false, occurrence.definition.ports, occurrence);
    };
    for (const [id, member] of children) {
      for (const port of member.item.definition.ports) {
        ports.set(portKey(nodeId(member.key), handleId(port.id)), {
          scope, module, port, direction: port.direction, endpoint: { instanceId: id, portId: port.id },
        });
      }
    }
    if (hasFrame) {
      for (const port of module.ports) {
        ports.set(portKey(boundary, handleId(port.id, true)), {
          scope, module, port, direction: port.direction === 'bidirectional' ? 'bidirectional' : port.direction === 'in' ? 'out' : 'in',
        });
      }
    }

    function edge(localId: string, selection: WiringSelection, portType: PortType, details: Omit<WiringEdge, 'id' | 'data' | 'type'>) {
      const active = highlighted?.has(localId);
      edges.push({ ...details, id: JSON.stringify([scope, localId]), type: 'signal', data: { wire: selection, scope, portType, caption: highlights.get(key)?.captions?.get(localId) },
        zIndex: active ? 1 : 0, className: active ? 'v1-path-edge' : undefined });
    }

    for (const item of module.connections ?? []) {
      edge(canvasEdgeKey('connection', item.id), { kind: 'connection', id: item.id }, childPort(item.from).type, {
        source: child(item.from.instanceId), target: child(item.to.instanceId),
        sourceHandle: handleId(item.from.portId), targetHandle: handleId(item.to.portId),
        ariaLabel: `连线：${childLabel(item.from)} ${wireArrow(childPort(item.from), childPort(item.to))} ${childLabel(item.to)}`,
      });
    }
    for (const mapping of module.portMappings ?? []) {
      const port = module.ports.find(port => port.id === mapping.portId)!;
      const outward = port.direction === 'out';
      const inner = { id: child(mapping.target.instanceId), handle: handleId(mapping.target.portId) };
      const outer = { id: boundary, handle: handleId(mapping.portId, true) };
      const [from, to] = outward ? [inner, outer] : [outer, inner];
      const id = mappingId(mapping);
      edge(canvasEdgeKey('mapping', id), { kind: 'mapping', id }, port.type, {
        source: from.id, target: to.id, sourceHandle: from.handle, targetHandle: to.handle,
        ariaLabel: `连接到内部端口：${portDisplayName(port, false, module.ports, projection.nodeByKey.get(key)?.item)} · ${childLabel(mapping.target)}`,
      });
    }
    for (const [index, bundle] of (module.cableBundles ?? []).entries()) {
      for (const core of bundle.cores) {
        if (!core.a.endpoint || !core.b.endpoint) continue;
        const a = core.a.endpoint;
        const aOutput = canConnect(childPort(a).direction, childPort(core.b.endpoint).direction);
        const [from, to] = aOutput ? [a, core.b.endpoint] : [core.b.endpoint, a];
        edge(canvasEdgeKey('core', bundle.id, core.id), { kind: 'core', id: core.id, bundleId: bundle.id }, childPort(from).type, {
          source: child(from.instanceId), target: child(to.instanceId),
          sourceHandle: handleId(from.portId), targetHandle: handleId(to.portId),
          ariaLabel: `线缆 ${index + 1} 纤芯 · A:${core.a.pin} / B:${core.b.pin}`,
        });
      }
    }
  }
  return { ports, edges };
}
