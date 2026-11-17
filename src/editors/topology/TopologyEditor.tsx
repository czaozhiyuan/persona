import { useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, applyNodeChanges, type Node, type NodeProps, type Connection as FlowConnection } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { buildGraph, type ResolvedInstance } from '../../engine/graph';
import type { Project, Endpoint } from '../../model/types';

const colors = { RF: '#eab56b', OPTICAL: '#6ed9c4', DC_POWER: '#ed8e9c', CONTROL: '#b7a3ee' };
type DeviceNode = Node<{ item: ResolvedInstance; active: boolean }, 'device'>;
function Device({ data }: NodeProps<DeviceNode>) {
  const module = !('transfers' in data.item.definition);
  const inputs = data.item.definition.ports.filter(p => p.direction === 'in');
  const outputs = data.item.definition.ports.filter(p => p.direction === 'out');
  return <div className={`device-node ${module ? 'module-node' : ''} ${data.active ? 'path-node' : ''}`} style={{ height: 65 + Math.max(inputs.length, outputs.length) * 23 }}>
    <div className="node-kind">{module ? 'MODULE' : data.item.definition.name} <span>{data.item.id}</span></div>
    <strong>{data.item.name}</strong>
    {(['in', 'out'] as const).map(direction => (direction === 'in' ? inputs : outputs).map((port, i) => <div key={port.id}>
      <Handle id={port.id} type={direction === 'in' ? 'target' : 'source'} position={direction === 'in' ? Position.Left : Position.Right} style={{ top: 65 + i * 23, background: colors[port.type], width: 9, height: 9 }} />
      <Handle id={`map-source-${port.id}`} type="source" isConnectable={false} position={direction === 'in' ? Position.Left : Position.Right} style={{ top: 65 + i * 23, width: 1, height: 1, opacity: 0 }} />
      <Handle id={`map-target-${port.id}`} type="target" isConnectable={false} position={direction === 'in' ? Position.Left : Position.Right} style={{ top: 65 + i * 23, width: 1, height: 1, opacity: 0 }} />
      <span className={`port-label ${direction}`} style={{ top: 57 + i * 23, color: colors[port.type] }}>{port.id}</span>
    </div>))}
  </div>;
}
const nodeTypes = { device: Device };
type Props = {
  project: Project; selected: string; highlightedNodes: string[]; highlightedConnections: string[];
  onSelect: (id: string) => void; onMove: (id: string, x: number, y: number) => void;
  onConnect: (from: Endpoint, to: Endpoint) => void;
  validate: (from: Endpoint, to: Endpoint) => boolean; onInvalid: () => void;
};
function endpoints(c: FlowConnection) {
  return [{ instanceId: c.source, portId: c.sourceHandle ?? '' }, { instanceId: c.target, portId: c.targetHandle ?? '' }] as const;
}
export function TopologyEditor({ project, selected, highlightedNodes, highlightedConnections, onSelect, onMove, onConnect, validate, onInvalid }: Props) {
  const graph = useMemo(() => buildGraph(project, undefined, true), [project]);
  const [nodes, setNodes] = useState<DeviceNode[]>([]);
  useEffect(() => {
    setNodes(previous => graph.instances.map((item, index) => ({
      ...previous.find(n => n.id === item.id),
      id: item.id, type: 'device', data: { item, active: highlightedNodes.includes(item.id) },
      position: project.layout.topology[item.id] ?? { x: index * 220, y: 600 }, selected: item.id === selected,
    })));
  }, [graph, selected, highlightedNodes, project.layout.topology]);
  const edges = graph.arcs.filter(a => a.kind === 'connection' || a.kind === 'mapping').map(a => {
    const [source, sourceHandle] = a.from.split(':'), [target, targetHandle] = a.to.split(':');
    const active = highlightedConnections.includes(a.id);
    const type = graph.ports.get(a.from)!.type;
    return { id: a.id, source, target, sourceHandle: a.kind === 'mapping' ? `map-source-${sourceHandle}` : sourceHandle, targetHandle: a.kind === 'mapping' ? `map-target-${targetHandle}` : targetHandle, label: a.id === 'shared-fiber' ? '共享光纤 · 2 通道' : a.kind === 'mapping' ? '端口映射' : undefined,
      animated: active && a.kind !== 'mapping', style: { stroke: active ? '#77e4ce' : colors[type], opacity: active ? 1 : .35, strokeWidth: active ? 3 : 1.5, strokeDasharray: a.kind === 'mapping' ? '5 4' : undefined },
      labelStyle: { fill: '#d7e3ed', fontSize: 12 }, labelBgStyle: { fill: '#182733' } };
  });
  return <div className="topology-canvas" data-testid="topology-canvas">
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.2} maxZoom={2}
      onNodeClick={(_, node) => onSelect(node.id)}
      onNodesChange={changes => setNodes(previous => applyNodeChanges(changes, previous))}
      onNodeDragStop={(_, node) => onMove(node.id, node.position.x, node.position.y)}
      onConnect={c => onConnect(...endpoints(c))}
      isValidConnection={c => validate(...endpoints(c))}
      onConnectEnd={(_, state) => { if (state.toNode && !state.isValid) onInvalid(); }}
      proOptions={{ hideAttribution: false }}>
      <Background color="#283e4b" gap={24} /><Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}
