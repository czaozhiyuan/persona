import { ConnectionMode, getEdgePosition } from '@xyflow/system';
import type { Node, ReactFlowInstance, Rect } from '@xyflow/react';
import type { TopologyWireRoute } from '../../../model/v1/types';
import { planOrthogonalRoutes, type RoutingObstacle, type RoutingWire } from './orthogonal-router';
import type { Projection } from './topology-layout-edits';
import { hierarchyKey } from './hierarchy-view';
import { nodeId, type WiringEdge } from './topology-wiring';

export function routeDisplayedScope<N extends Node>(projection: Projection, edges: readonly WiringEdge[],
  flow: ReactFlowInstance<N, WiringEdge>, canvas: HTMLElement, scopeKey: string) {
  const scope = projection.scopes.get(scopeKey)!;
  const scoped = edges.filter(edge => hierarchyKey(edge.data!.scope) === scopeKey);
  const root = nodeId(scopeKey);
  const frame = projection.nodeByKey.get(scopeKey)?.frame;
  const rootNode = flow.getInternalNode(root);
  const origin = rootNode?.internals.positionAbsolute;
  const dx = origin && frame ? origin.x - frame.display.x : 0;
  const dy = origin && frame ? origin.y - frame.display.y : 0;
  const obstacles: RoutingObstacle[] = [];
  const result: TopologyWireRoute[] = [];
  let boundary: Rect | undefined;
  for (const member of scope.members) {
    const id = nodeId(member.key);
    const n = flow.getInternalNode(id);
    if (!n?.measured.width || !n.measured.height) return { routes: result, failed: scoped.length };
    const p = n.internals.positionAbsolute;
    obstacles.push({ id, x: p.x - dx, y: p.y - dy, width: n.measured.width, height: n.measured.height });
  }
  if (frame) {
    const element = canvas.querySelector<HTMLElement>('.react-flow__node[data-id="' + CSS.escape(root) + '"]');
    if (!element || !rootNode?.measured.width || !rootNode.measured.height) return { routes: result, failed: scoped.length };
    boundary = frame.display;
    function addObstacle(id: string, left: number, top: number, right: number, bottom: number) {
      const p = flow.screenToFlowPosition({ x: left, y: top }, { snapToGrid: false });
      obstacles.push({ id, x: p.x - dx, y: p.y - dy, width: (right - left) / flow.getZoom(), height: (bottom - top) / flow.getZoom() });
    }
    // Keep the full title row draggable. Only its rendered contents obstruct wires.
    const titleParts = Array.from(element.querySelectorAll('.v1-frame-title > *'), part => part.getBoundingClientRect())
      .filter(box => box.width > 0 && box.height > 0);
    if (titleParts.length) {
      addObstacle('frame-title', Math.min(...titleParts.map(b => b.left)), Math.min(...titleParts.map(b => b.top)),
        Math.max(...titleParts.map(b => b.right)), Math.max(...titleParts.map(b => b.bottom)));
    }
    for (const label of element.querySelectorAll<HTMLElement>('.v1-topology-port .v1-port-label')) {
      const box = label.getBoundingClientRect();
      const inner = label.closest('.v1-topology-port')?.querySelector<HTMLElement>('.v1-frame-inner-handle')?.dataset.handleid;
      addObstacle(inner ?? 'frame-title', box.left, box.top, box.right, box.bottom);
    }
  }
  const wires: RoutingWire[] = [];
  for (const edge of scoped) {
    const sourceNode = flow.getInternalNode(edge.source), targetNode = flow.getInternalNode(edge.target);
    if (!sourceNode || !targetNode) continue;
    const pos = getEdgePosition({ id: edge.id, sourceNode, targetNode, sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null, connectionMode: ConnectionMode.Loose });
    if (pos) wires.push({ id: edge.id,
      source: { x: pos.sourceX - dx, y: pos.sourceY - dy, side: pos.sourcePosition, obstacle: edge.source === root ? edge.sourceHandle! : edge.source },
      target: { x: pos.targetX - dx, y: pos.targetY - dy, side: pos.targetPosition, obstacle: edge.target === root ? edge.targetHandle! : edge.target },
    });
  }
  const planned = planOrthogonalRoutes({ obstacles, boundary, wires });
  for (const edge of scoped) {
    const points = planned.get(edge.id);
    if (points) result.push({ modulePath: scope.path, wire: edge.data!.wire, kind: 'orthogonal', points });
  }
  return { routes: result, failed: scoped.length - result.length };
}
