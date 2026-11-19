import { Background, Controls, Handle, Position, ReactFlow } from '@xyflow/react';
import type { Edge, Node, NodeProps } from '@xyflow/react';
import { useMemo } from 'react';
import type { PathResult } from '../../../engine/v1/path-resolver';
import { signalPortKey } from '../../../engine/v1/signal-graph';
import type { SignalEdge, SignalGraph } from '../../../engine/v1/signal-graph';
import type { InstancePath, PortDefinition } from '../../../model/v1/types';
import { hierarchyKey, layoutHierarchy } from './hierarchy-view';

type OverviewNode = Node<{
  path: InstancePath;
  name: string;
  ports: readonly PortDefinition[];
  activePorts: ReadonlySet<string>;
  module: boolean;
  boundary: boolean;
  expanded: boolean;
}, 'overview'>;

const nodeId = (key: string) => encodeURIComponent(key);
const portId = (id: string, inner: boolean) => encodeURIComponent(JSON.stringify([id, inner]));

function OverviewCard({ data, selected }: NodeProps<OverviewNode>) {
  return <div className={`v1-overview-card${data.expanded ? ' is-container' : ''}${selected ? ' is-selected' : ''}`}>
    <div className="v1-overview-header">
      <strong title={data.name}>{data.name}</strong>
      {data.ports.map(port => {
        const externalOutput = port.direction === 'out';
        const handle = (inner: boolean) => {
          const output = externalOutput !== inner;
          return <Handle id={portId(port.id, inner)} type={output ? 'source' : 'target'}
            position={output ? Position.Right : Position.Left} className={port.type} isConnectable={false} />;
        };
        return <div className={`v1-topology-port${data.activePorts.has(port.id) ? ' is-on-path' : ''}`} key={port.id}>
          {handle(data.boundary)}
          {data.expanded && handle(true)}
          <span title={port.id}>{port.id}</span><small>{port.type}</small>
        </div>;
      })}
    </div>
  </div>;
}

const nodeTypes = { overview: OverviewCard };

function visualKey(edge: SignalEdge): string | undefined {
  const source = edge.source;
  if (source.kind === 'portMapping') return JSON.stringify(['mapping', source.publicPort.instancePath, source.publicPort.portId]);
  if (source.kind === 'connection') return JSON.stringify(['connection', source.ref.scopePath, source.ref.connectionId]);
  if (source.kind === 'cableCore') return JSON.stringify(['core', source.ref.scopePath, source.ref.bundleId, source.ref.coreId]);
}

export function HierarchyCanvas({ graph, scope, depth, result, selected, select, navigate }: {
  graph: SignalGraph;
  scope: InstancePath;
  depth: number;
  result?: PathResult;
  selected?: InstancePath;
  select: (path?: InstancePath) => void;
  navigate: (path: InstancePath) => void;
}) {
  const active = selected && hierarchyKey(selected);
  const scopeKey = hierarchyKey(scope);
  const projection = useMemo(() => layoutHierarchy(graph.instances, scope, depth), [graph, scope, depth]);
  const { nodes, edges } = useMemo(() => {
    const paths = [result?.trace, ...(result?.trace?.supplies.flatMap(supply => supply.status === 'resolved' ? [supply.path] : []) ?? [])];
    const activeEdges = new Set(paths.flatMap(path => path?.edges.map(visualKey) ?? []));
    const activePorts = new Set(paths.flatMap(path => path?.steps.map(step => signalPortKey(step.port.ref)) ?? []));
    const visible = new Set(projection.map(item => item.key));
    const nodes: OverviewNode[] = projection.map(({ item, key, parentKey, position, expanded, width, height }) => ({
      id: nodeId(key), type: 'overview', position, parentId: parentKey === undefined ? undefined : nodeId(parentKey),
      style: { width, height }, selected: active === key, selectable: key !== scopeKey,
      data: { path: item.instancePath, name: key === scopeKey ? '公开端口' : item.instance?.name ?? item.definition.name,
        ports: item.definition.ports, module: item.definition.kind === 'module', boundary: key === scopeKey, expanded,
        activePorts: new Set(item.definition.ports.filter(port => activePorts.has(signalPortKey({
          instancePath: item.instancePath, portId: port.id,
        }))).map(port => port.id)) },
    }));
    const edges: Edge[] = [];
    for (const edge of graph.edges) {
      const id = visualKey(edge);
      const from = hierarchyKey(edge.from.ref.instancePath);
      const to = hierarchyKey(edge.to.ref.instancePath);
      if (!id || !visible.has(from) || !visible.has(to)) continue;
      const source = edge.source;
      const outer = source.kind === 'portMapping' ? hierarchyKey(source.publicPort.instancePath) : undefined;
      const highlighted = activeEdges.has(id);
      edges.push({
        id, source: nodeId(from), target: nodeId(to),
        sourceHandle: portId(edge.from.ref.portId, from === outer), targetHandle: portId(edge.to.ref.portId, to === outer),
        label: source.kind === 'cableCore' ? `A:${source.aPin} / B:${source.bPin}` : undefined,
        zIndex: 2, className: highlighted ? 'v1-path-edge' : undefined,
        style: { stroke: highlighted ? '#a85618' : source.kind === 'cableCore' ? '#7856b7' : '#658681',
          strokeWidth: highlighted ? 3 : 2, strokeDasharray: source.kind === 'portMapping' ? '6 4' : undefined },
      });
    }
    return { nodes, edges };
  }, [active, graph, projection, result, scopeKey]);

  return <div className="v1-topology-canvas" aria-label="多层逻辑拓扑">
    <ReactFlow<OverviewNode, Edge> nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      fitView minZoom={0.001} maxZoom={2} nodesDraggable={false} nodesConnectable={false} deleteKeyCode={null}
      onPaneClick={() => select()}
      onNodeClick={(_, node) => { if (!node.data.boundary) select(node.data.path); }}
      onNodeDoubleClick={(_, node) => { if (!node.data.boundary && node.data.module) navigate(node.data.path); }}>
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}
