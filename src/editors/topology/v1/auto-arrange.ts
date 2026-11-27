import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Rect, XYPosition } from '@xyflow/react';
import { resolveHierarchy } from '../../../engine/v1/hierarchy';
import type { ComponentDefinition, PortDefinition, Project, TopologyPlacement } from '../../../model/v1/types';
import { isPowerPort } from '../../../model/v1/types';
import { gridPoint, topologyGrid } from '../../../state/v1/topology-grid';
import { moveTopologyNodes, resizeTopologyFrame } from '../../../state/v1/topology-edits';
import { defaultTopologyPosition } from '../../../state/v1/topology-position';
import { framePadding } from './module-frame';
import { hierarchyKey } from './hierarchy-view';
import type { Projection } from './topology-layout-edits';
import { handleId, nodeId, portKey, type WiringEdge } from './topology-wiring';

export type MeasuredBlock = { width: number; height: number; handles: ReadonlyMap<string, XYPosition> };
const gap = 40, layerGap = 80;
const side = { in: 'WEST', out: 'EAST', bidirectional: 'NORTH' };
const ceilGrid = (n: number) => Math.ceil(n / topologyGrid) * topologyGrid;
const compareId = (a: string, b: string) => a < b ? -1 : Number(a > b);
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width
  && a.y < b.y + b.height && b.y < a.y + a.height;
let engine: InstanceType<typeof ELK> | undefined;

function signalRole(chip: ComponentDefinition, id: string, type: PortDefinition['type']) {
  if (type === 'OPTICAL') return chip.transfers?.some(t => t.kind === 'eo' && t.supplyPortId === id) ? 'supply' : 'other';
  const transfers = chip.transfers?.filter(t => t.fromPortId === id || t.toPortId === id);
  if (transfers?.some(t => t.kind === 'digitalTx' || t.kind === 'digitalRx')) return 'digital';
  if (transfers?.some(t => t.kind === 'control') || chip.ports.every(p => p.type === 'CONTROL' || isPowerPort(p.type))) return 'control';
  return 'other';
}

/** Layout-only graph. All positions and edge endpoints below are local to the editing scope. */
export async function arrangeScope(project: Project, view: Projection, edges: readonly WiringEdge[],
  measure: (id: string) => MeasuredBlock | undefined, scopeKey = view.rootKey) {
  const scope = view.scopes.get(scopeKey)!;
  const scoped = edges.filter(edge => hierarchyKey(edge.data!.scope) === scopeKey);
  if (!scope.members.length) return project;
  if (scope.members.length > 300 || scoped.length > 1500 || scope.members.reduce((n, m) => n + m.item.definition.ports.length, 0) > 3000) {
    throw new Error('当前层级对象或连线过多，无法一次整理。');
  }
  const stored = new Map(project.layout?.topology?.map(p => [hierarchyKey(p.instancePath), p]));
  const nodes = scope.members.map((member, index) => {
    const id = nodeId(member.key), definition = member.item.definition;
    const box = measure(id);
    if (!box?.width || !box.height) throw new Error('画布尺寸尚未就绪，请重试。');
    const ports = new Map<string, PortDefinition>();
    const elk: ElkNode = { id, width: box.width, height: box.height, layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
      ports: definition.ports.map(port => {
        const handle = handleId(port.id), at = box.handles.get(handle);
        if (!at) throw new Error('端口位置尚未就绪，请重试。');
        ports.set(handle, port);
        return { id: portKey(id, handle), ...at, width: 0, height: 0, layoutOptions: { 'elk.port.side': side[port.direction] } };
      }) };
    const saved = stored.get(member.key) ?? defaultTopologyPosition(index, scope.definition.ports.length);
    return { id, member, saved, definition, ports, elk, width: box.width, height: box.height,
      neighbours: new Set<string>(), primary: false };
  }).sort((a, b) => compareId(a.id, b.id));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const graphEdges: NonNullable<ElkNode['edges']> = [];
  let hierarchy: ReturnType<typeof resolveHierarchy> | undefined;
  const roles = new Map<string, ReturnType<typeof signalRole>>();
  function role(node?: typeof nodes[number], port?: PortDefinition) {
    if (!node || !port) return;
    if (node.definition.kind === 'component') return signalRole(node.definition, port.id, port.type);
    const key = portKey(node.definition.id, port.id);
    if (!roles.has(key)) {
      hierarchy ??= resolveHierarchy(project);
      // Signal ports have at most one mapping per level. Only the leaf has a physical transfer role.
      const resolved = hierarchy.resolvePort({ instancePath: node.member.item.instancePath, portId: port.id });
      const end = resolved.status === 'resolved' ? resolved.chain.at(-1) : undefined;
      const chip = end && hierarchy.resolveInstance(end.instancePath)?.definition;
      roles.set(key, end && chip?.kind === 'component' ? signalRole(chip, end.portId, port.type) : 'other');
    }
    return roles.get(key);
  }
  for (const edge of [...scoped].sort((a, b) => compareId(a.id, b.id))) {
    const a = byId.get(edge.source), b = byId.get(edge.target);
    const from = a?.ports.get(edge.sourceHandle!), to = b?.ports.get(edge.targetHandle!);
    a?.neighbours.add(edge.target);
    b?.neighbours.add(edge.source);
    if (isPowerPort(edge.data!.portType)) continue;
    if (edge.data!.portType === 'CONTROL') {
      const source = role(a, from), target = role(b, to);
      // A digital conversion pin identifies an actual signal even on a mixed-function controller.
      if (source !== 'digital' && target !== 'digital' && (source === 'other' || target === 'other')) continue;
    }
    if (edge.data!.portType === 'OPTICAL' && (role(a, from) === 'supply' || role(b, to) === 'supply')) continue;
    if (a) a.primary = true;
    if (b) b.primary = true;
    if (!a || !b || a === b) continue;
    const x = portKey(a.id, edge.sourceHandle), y = portKey(b.id, edge.targetHandle);
    const reverse = from?.direction === 'in' || to?.direction === 'out'
      || from?.direction === 'bidirectional' && to?.direction === 'bidirectional' && compareId(a.id, b.id) > 0;
    graphEdges.push({ id: edge.id, sources: [reverse ? y : x], targets: [reverse ? x : y] });
  }

  const frame = view.nodeByKey.get(scopeKey)?.frame;
  const left = frame ? ceilGrid(frame.display.x + frame.insets.left + gap) : gridPoint({ x: Math.min(...nodes.map(n => n.member.bounds.x)), y: 0 }).x;
  const top = frame ? ceilGrid(frame.display.y + frame.insets.top + gap) : gridPoint({ x: 0, y: Math.min(...nodes.map(n => n.member.bounds.y)) }).y;
  const placed = new Map<string, Rect>();
  function place(n: typeof nodes[number], x: number, y: number) {
    const rect = { ...gridPoint({ x, y }), width: n.width, height: n.height };
    const overlaps = [...placed.values()].filter(b => rect.x < b.x + b.width && b.x < rect.x + rect.width).sort((a, b) => a.y - b.y);
    for (const other of overlaps) if (intersects(rect, other)) rect.y = ceilGrid(other.y + other.height + gap);
    placed.set(n.id, rect);
  }
  const primary = nodes.filter(n => n.primary);
  if (primary.length) {
    engine ??= new ELK({ algorithms: ['layered'] });
    const result = await engine.layout({ id: 'layout', layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': String(gap),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(layerGap), 'elk.edgeRouting': 'ORTHOGONAL',
    }, children: primary.map(n => n.elk), edges: graphEdges });
    const positioned = result.children ?? [];
    if (positioned.length !== primary.length || positioned.some(n => !Number.isFinite(n.x) || !Number.isFinite(n.y))) {
      throw new Error('排列算法未返回完整位置。');
    }
    const minX = Math.min(...positioned.map(n => n.x!)), minY = Math.min(...positioned.map(n => n.y!));
    for (const n of positioned) place(byId.get(n.id)!, left + n.x! - minX, top + n.y! - minY);
  }
  const nextRow = () => placed.size ? Math.max(...[...placed.values()].map(r => r.y + r.height)) + gap : top;
  const powerOnly = (n: typeof nodes[number]) => n.definition.ports.every(p => isPowerPort(p.type));
  const auxiliaries = nodes.filter(n => !n.primary && n.neighbours.size).sort((a, b) => Number(powerOnly(a)) - Number(powerOnly(b)));
  // Prefer the input side of signal peers for lasers/controllers. Reserve a lower row for power.
  let auxX = left, powerRow: number | undefined;
  for (const n of auxiliaries) {
    const peers = [...n.neighbours].flatMap(id => placed.get(id) ?? []).sort((a, b) => a.x - b.x);
    const peer = peers[Math.floor(peers.length / 2)];
    const power = powerOnly(n);
    const x = peer ? Math.max(left, power ? peer.x : peer.x - n.width - layerGap) : auxX;
    if (power) powerRow ??= nextRow();
    place(n, x, powerRow ?? peer?.y ?? top);
    auxX = Math.max(auxX, x + n.width + gap);
  }
  const isolated = nodes.filter(n => !n.primary && !n.neighbours.size);
  const columns = Math.ceil(Math.sqrt(isolated.length));
  let x = left, y = nextRow();
  isolated.forEach((n, index) => {
    if (index && index % columns === 0) { x = left; y = nextRow(); }
    place(n, x, y);
    x += n.width + gap;
  });

  const moves: TopologyPlacement[] = [];
  for (const n of nodes) {
    const { x, y } = placed.get(n.id)!;
    if (x !== n.saved.x || y !== n.saved.y) moves.push({ instancePath: n.member.item.instancePath, x, y });
  }
  let next = moveTopologyNodes(project, moves);
  if (frame) {
    const rects = [...placed.values()];
    const saved = project.layout?.topologyFrames?.find(f => hierarchyKey(f.modulePath) === scopeKey);
    const width = Math.max(saved?.width ?? 0, frame.insets.minWidth, ceilGrid(Math.max(...rects.map(r => r.x + r.width)) + frame.insets.right + gap - frame.display.x));
    const height = Math.max(saved?.height ?? 0, frame.insets.height, ceilGrid(Math.max(...rects.map(r => r.y + r.height)) + framePadding + gap - frame.display.y));
    if (saved ? width > saved.width || height > saved.height : moves.length || width > frame.base.width || height > frame.base.height) {
      next = resizeTopologyFrame(next, { modulePath: scope.path, x: frame.display.x, y: frame.display.y, width, height });
    }
  }
  return next;
}
