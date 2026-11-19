import { Background, Controls, Handle, Position, ReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import type { Connection as FlowConnection, Edge, Node, NodeProps, XYPosition } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { signalPortKey } from '../../../engine/v1/signal-graph';
import type { Connection, LocalEndpointRef } from '../../../model/v1/topology';
import type { InstancePath, ModuleDefinition, PortDefinition, PortMapping, Project } from '../../../model/v1/types';
import { canvasEdgeKey } from './path-highlight';
import type { projectPathHighlight } from './path-highlight';
import { frameHeader, frameInsets, framePadding, ModuleFrame } from './module-frame';
import '@xyflow/react/dist/style.css';

type NodeData = { name: string; ports: readonly PortDefinition[]; pathPorts: ReadonlySet<string>; foldedPath?: boolean };
type DeviceNode = Node<NodeData, 'device'>;
type FrameNode = Node<NodeData, 'moduleFrame'>;
type CanvasNode = DeviceNode | FrameNode;

const boundary = 'boundary';
const nodeId = (id: string) => encodeURIComponent(JSON.stringify(['instance', id]));
const handleId = (id: string) => encodeURIComponent(JSON.stringify(['port', id]));

function Device({ id, data, selected }: NodeProps<DeviceNode>) {
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => updateInternals(id), [id, data.ports, data.foldedPath, updateInternals]);
  return (
    <div className={`v1-topology-device${selected ? ' is-selected' : ''}${data.foldedPath ? ' has-folded-path' : ''}`}>
      <strong>{data.name}</strong>
      {data.foldedPath && <span className="v1-topology-path-label">路径经过内部</span>}
      {data.ports.map(port => {
        const output = port.direction === 'out';
        return (
          <div key={port.id} className={`v1-topology-port ${output ? 'out' : 'in'}${data.pathPorts.has(port.id) ? ' is-on-path' : ''}`} title={port.id}>
            <Handle id={handleId(port.id)} type={output ? 'source' : 'target'}
              position={output ? Position.Right : Position.Left} className={port.type} />
            <span>{port.id}</span><small>{port.type}</small>
          </div>
        );
      })}
    </div>
  );
}

function Frame({ id, data }: NodeProps<FrameNode>) {
  return <ModuleFrame id={id} name={data.name} ports={data.ports} highlighted={data.pathPorts} handleId={handleId} editable />;
}

const nodeTypes = { device: Device, moduleFrame: Frame };

function moduleFrame(nodes: DeviceNode[], data: NodeData): FrameNode {
  const insets = frameInsets(data.ports);
  let left = nodes[0]?.position.x ?? 0;
  let top = nodes[0]?.position.y ?? 0;
  let right = left;
  let bottom = top;
  for (const { position, measured, data } of nodes) {
    left = Math.min(left, position.x);
    top = Math.min(top, position.y);
    right = Math.max(right, position.x + (measured?.width ?? 202));
    bottom = Math.max(bottom, position.y + (measured?.height ?? (48 + data.ports.length * 24)));
  }
  left -= insets.left;
  top -= frameHeader;
  return { id: boundary, type: 'moduleFrame', position: { x: left, y: top },
    style: { width: Math.max(360, right - left + insets.right), height: Math.max(insets.height, bottom - top + framePadding),
      pointerEvents: 'none' },
    draggable: false, selectable: false, focusable: false, zIndex: -1, data };
}

type Props = {
  project: Project;
  module: ModuleDefinition;
  moduleName: string;
  modulePath: InstancePath;
  selectedInstance?: InstancePath;
  highlight: ReturnType<typeof projectPathHighlight>;
  selectInstance: (path?: InstancePath) => void;
  enterModule: (path: InstancePath) => void;
  move: (instanceId: string, position: XYPosition) => void;
  connect: (connection: Omit<Connection, 'id'>) => void;
  mapPort: (mapping: PortMapping) => void;
};

export function TopologyCanvas({ project, module, moduleName, modulePath, selectedInstance, highlight, selectInstance, enterModule, move, connect, mapPort }: Props) {
  const [drag, setDrag] = useState<{ id: string; position: XYPosition }>();
  const [measurements, setMeasurements] = useState<ReadonlyMap<string, { width: number; height: number }>>(new Map());
  const definitions = new Map([...project.moduleDefinitions, ...project.componentDefinitions].map(def => [def.id, def]));
  const positions = new Map(project.layout?.topology?.map(item => [JSON.stringify(item.instancePath), item]));
  const instances = new Map(module.instances.map(instance => [nodeId(instance.id), instance]));
  const selected = selectedInstance && JSON.stringify(selectedInstance);
  const pathPorts = (path: InstancePath, ports: readonly PortDefinition[]) =>
    new Set(ports.filter(port => highlight.ports.has(signalPortKey({ instancePath: path, portId: port.id }))).map(port => port.id));
  const devices: DeviceNode[] = module.instances.map((instance, index) => {
    const id = nodeId(instance.id);
    const path = [...modulePath, instance.id];
    const saved = positions.get(JSON.stringify(path));
    const position = drag?.id === id ? drag.position : saved ? { x: saved.x, y: saved.y }
      : { x: 260 * (index % 3) + (module.ports.length ? 260 : 25), y: 240 * Math.floor(index / 3) + 25 };
    const ports = definitions.get(instance.definitionId)!.ports;
    return { id, type: 'device', position, selected: selected === JSON.stringify(path), measured: measurements.get(id),
      data: { name: instance.name, ports, foldedPath: highlight.folded.has(instance.id), pathPorts: pathPorts(path, ports) } };
  });
  const framed = modulePath.length > 0 || module.ports.length > 0;
  const nodes: CanvasNode[] = framed ? [
    moduleFrame(devices, { name: moduleName, ports: module.ports, pathPorts: pathPorts(modulePath, module.ports) }), ...devices,
  ] : devices;

  const edges: Edge[] = (module.connections ?? []).map(item => ({
    id: canvasEdgeKey('connection', item.id), source: nodeId(item.from.instanceId), target: nodeId(item.to.instanceId),
    sourceHandle: handleId(item.from.portId), targetHandle: handleId(item.to.portId), label: item.mediaKind,
  }));
  for (const mapping of module.portMappings ?? []) {
    const outward = module.ports.find(port => port.id === mapping.portId)?.direction === 'out';
    const inner = { id: nodeId(mapping.target.instanceId), handle: handleId(mapping.target.portId) };
    const outer = { id: boundary, handle: handleId(mapping.portId) };
    const [from, to] = outward ? [inner, outer] : [outer, inner];
    edges.push({ id: canvasEdgeKey('mapping', mapping.portId), source: from.id, target: to.id,
      sourceHandle: from.handle, targetHandle: to.handle, style: { strokeDasharray: '6 4' } });
  }
  for (const bundle of module.cableBundles ?? []) {
    for (const core of bundle.cores) {
      if (!core.a.endpoint || !core.b.endpoint) continue;
      const a = core.a.endpoint;
      const instance = instances.get(nodeId(a.instanceId))!;
      const aOutput = definitions.get(instance.definitionId)?.ports.find(port => port.id === a.portId)?.direction === 'out';
      const [from, to] = aOutput ? [a, core.b.endpoint] : [core.b.endpoint, a];
      edges.push({ id: canvasEdgeKey('core', bundle.id, core.id), source: nodeId(from.instanceId), target: nodeId(to.instanceId),
        sourceHandle: handleId(from.portId), targetHandle: handleId(to.portId),
        label: `${bundle.id} · A:${core.a.pin} / B:${core.b.pin}`, style: { stroke: '#7856b7', strokeWidth: 2 } });
    }
  }

  function localEndpoint(node: string, handle: string | null): LocalEndpointRef | undefined {
    const instance = instances.get(node);
    if (!instance) return;
    const port = definitions.get(instance.definitionId)?.ports.find(item => handleId(item.id) === handle);
    if (port) return { instanceId: instance.id, portId: port.id };
  }

  function onConnect(edge: FlowConnection) {
    const from = localEndpoint(edge.source, edge.sourceHandle);
    const to = localEndpoint(edge.target, edge.targetHandle);
    if (from && to) {
      connect({ from, to });
    } else if (edge.source === boundary || edge.target === boundary) {
      const port = module.ports.find(item => handleId(item.id) === (edge.source === boundary ? edge.sourceHandle : edge.targetHandle));
      const target = from ?? to;
      if (port && target) mapPort({ portId: port.id, target });
    }
  }

  return (
    <div className="v1-topology-canvas" aria-label="逻辑拓扑画布">
      <ReactFlow<CanvasNode, Edge> nodes={nodes} edges={edges.map(edge => highlight.edges.has(edge.id)
        ? { ...edge, className: 'v1-path-edge', style: { ...edge.style, stroke: '#a85618', strokeWidth: 3 }, zIndex: 2 } : edge)}
        nodeTypes={nodeTypes} fitView
        minZoom={0.2} maxZoom={2} deleteKeyCode={null} onConnect={onConnect} onPaneClick={() => selectInstance()}
        onNodeClick={(_, node) => {
          const instance = instances.get(node.id);
          if (instance) selectInstance([...modulePath, instance.id]);
        }}
        onNodeDoubleClick={(_, node) => {
          const instance = instances.get(node.id);
          if (instance && definitions.get(instance.definitionId)?.kind === 'module') enterModule([...modulePath, instance.id]);
        }}
        onNodesChange={changes => {
          const change = changes.find(item => item.type === 'position' && item.dragging);
          if (change?.type === 'position' && change.position) setDrag({ id: change.id, position: change.position });
          if (framed && changes.some(item => item.type === 'dimensions' && item.id !== boundary)) setMeasurements(current => {
            const next = new Map(current);
            for (const item of changes) {
              if (item.type !== 'dimensions' || item.id === boundary || !item.dimensions) continue;
              const previous = next.get(item.id);
              if (previous?.width !== item.dimensions.width || previous?.height !== item.dimensions.height) next.set(item.id, item.dimensions);
            }
            return [...next].every(([id, value]) => current.get(id) === value) ? current : next;
          });
        }}
        onNodeDragStop={(_, node) => {
          setDrag(undefined);
          const instance = instances.get(node.id);
          if (!instance) return;
          const path = [...modulePath, instance.id];
          const index = module.instances.indexOf(instance);
          const saved = positions.get(JSON.stringify(path));
          const previous = saved ?? { x: 260 * (index % 3) + (module.ports.length ? 260 : 25), y: 240 * Math.floor(index / 3) + 25 };
          if (node.position.x !== previous.x || node.position.y !== previous.y) move(instance.id, node.position);
        }}>
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
      {!nodes.length && <span className="v1-topology-empty">添加实例或声明公开端口以开始。</span>}
    </div>
  );
}
