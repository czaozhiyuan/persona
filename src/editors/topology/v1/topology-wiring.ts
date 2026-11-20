import type { Edge } from '@xyflow/react';
import { mediaLabels, portDisplayName } from '../../../workbench/v1/labels';
import type { LocalEndpointRef } from '../../../model/v1/topology';
import type { InstancePath, ModuleDefinition } from '../../../model/v1/types';
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
export type WiringEdge = Edge<WiringSelection & { scope: InstancePath }>;

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

  function append(module: ModuleDefinition, scope: InstancePath, key: string, members: readonly TopologyItem[], hasFrame: boolean) {
    const highlighted = highlights.get(key)?.edges;
    const boundary = nodeId(key);
    const children = new Map(members.map(member => [member.item.instance!.id, member]));
    const child = (id: string) => nodeId(children.get(id)!.key);
    const childPort = ({ instanceId, portId }: LocalEndpointRef) => children.get(instanceId)!.item.definition.ports.find(port => port.id === portId)!;
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
          scope, module, port, direction: port.direction === 'in' ? 'out' : 'in',
        });
      }
    }

    function edge(localId: string, selection: WiringSelection, details: Omit<WiringEdge, 'id' | 'data'>) {
      const active = highlighted?.has(localId);
      edges.push({ ...details, id: JSON.stringify([scope, localId]), data: { ...selection, scope },
        zIndex: active ? 1 : 0, className: active ? 'v1-path-edge' : undefined,
        style: active ? { ...details.style, stroke: '#a85618', strokeWidth: 3 } : details.style });
    }

    for (const item of module.connections ?? []) {
      edge(canvasEdgeKey('connection', item.id), { kind: 'connection', id: item.id }, {
        source: child(item.from.instanceId), target: child(item.to.instanceId),
        sourceHandle: handleId(item.from.portId), targetHandle: handleId(item.to.portId),
        ariaLabel: `连线：${portDisplayName(childPort(item.from))} → ${portDisplayName(childPort(item.to))}`,
        label: item.mediaKind && mediaLabels[item.mediaKind],
      });
    }
    for (const mapping of module.portMappings ?? []) {
      const port = module.ports.find(port => port.id === mapping.portId)!;
      const outward = port.direction === 'out';
      const inner = { id: child(mapping.target.instanceId), handle: handleId(mapping.target.portId) };
      const outer = { id: boundary, handle: handleId(mapping.portId, true) };
      const [from, to] = outward ? [inner, outer] : [outer, inner];
      edge(canvasEdgeKey('mapping', mapping.portId), { kind: 'mapping', id: mapping.portId }, {
        source: from.id, target: to.id, sourceHandle: from.handle, targetHandle: to.handle,
        ariaLabel: `连接到内部端口：${portDisplayName(port)} · ${portDisplayName(childPort(mapping.target))}`, style: { strokeDasharray: '6 4' },
      });
    }
    for (const bundle of module.cableBundles ?? []) {
      for (const core of bundle.cores) {
        if (!core.a.endpoint || !core.b.endpoint) continue;
        const a = core.a.endpoint;
        const aOutput = children.get(a.instanceId)!.item.definition.ports.find(port => port.id === a.portId)?.direction === 'out';
        const [from, to] = aOutput ? [a, core.b.endpoint] : [core.b.endpoint, a];
        edge(canvasEdgeKey('core', bundle.id, core.id), { kind: 'core', id: core.id, bundleId: bundle.id }, {
          source: child(from.instanceId), target: child(to.instanceId),
          sourceHandle: handleId(from.portId), targetHandle: handleId(to.portId),
          ariaLabel: `纤芯：${bundle.id} · ${core.id}`,
          label: `${bundle.id} · A:${core.a.pin} / B:${core.b.pin}`, style: { stroke: '#7856b7', strokeWidth: 2 },
        });
      }
    }
  }
  return { ports, edges };
}
