import { mediaLabels, portDisplayName, portTypeLabels } from '../../../workbench/v1/labels';
import { Background, Handle, Position, ReactFlow, useNodesState, useUpdateNodeInternals } from '@xyflow/react';
import type { Connection as FlowConnection, Edge, Node, NodeChange, NodeProps, ReactFlowInstance, Viewport, XYPosition } from '@xyflow/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { signalPortKey } from '../../../engine/v1/signal-graph';
import type { Connection, LocalEndpointRef } from '../../../model/v1/topology';
import type { InstancePath, ModuleDefinition, PortDefinition, PortMapping, Project } from '../../../model/v1/types';
import { canvasEdgeKey } from './path-highlight';
import type { projectPathHighlight } from './path-highlight';
import { frameHeader, frameInsets, framePadding, ModuleFrame } from './module-frame';
import { keepGraphVisible } from './viewport';
import { CanvasControls, canvasFitOptions, flowAriaLabels } from './canvas-controls';
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
            <span>{portDisplayName(port.id)}</span><small>{portTypeLabels[port.type]}</small>
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
  return { id: boundary, ariaLabel: data.name, type: 'moduleFrame', position: { x: left, y: top },
    style: { width: Math.max(360, right - left + insets.right), height: Math.max(insets.height, bottom - top + framePadding),
      pointerEvents: 'none' },
    draggable: false, selectable: false, focusable: false, zIndex: -1, data };
}

type Props = {
  project: Project;
  module: ModuleDefinition;
  moduleName: string;
  treeHidden: boolean;
  modulePath: InstancePath;
  selectedInstance?: InstancePath;
  highlight: ReturnType<typeof projectPathHighlight>;
  selectInstance: (path?: InstancePath) => void;
  enterModule: (path: InstancePath) => void;
  move: (instanceId: string, position: XYPosition) => void;
  connect: (connection: Omit<Connection, 'id'>) => void;
  mapPort: (mapping: PortMapping) => void;
};

export function TopologyCanvas({ project, module, moduleName, modulePath, treeHidden, selectedInstance, highlight, selectInstance, enterModule, move, connect, mapPort }: Props) {
  const [viewport, setViewport] = useState<Viewport>();
  const canvas = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<CanvasNode, Edge>>(null);

  const changeViewport = useCallback((requested: Viewport) => {
    const displayed = flow.current?.getNodes() ?? [];
    // Keep an internal instance visible when possible, or the frame itself in an empty module.
    const bounds = displayed.filter(node => node.id !== boundary || displayed.length === 1).flatMap(({ id }) => {
      const node = flow.current?.getInternalNode(id);
      const width = node?.measured.width ?? 0;
      const height = node?.measured.height ?? 0;
      return node && width > 0 && height > 0 ? [{ ...node.internals.positionAbsolute, width, height }] : [];
    });
    const next = keepGraphVisible(requested, canvas.current?.clientWidth ?? 0, canvas.current?.clientHeight ?? 0, bounds);
    setViewport(next);
  }, []);
  const definitions = useMemo(() => new Map([...project.moduleDefinitions, ...project.componentDefinitions].map(def => [def.id, def])), [project]);
  const instances = new Map(module.instances.map(instance => [nodeId(instance.id), instance]));
  const selected = selectedInstance && JSON.stringify(selectedInstance);
  const projectedNodes = useMemo(() => {
    const positions = new Map(project.layout?.topology?.map(item => [JSON.stringify(item.instancePath), item]));
    const pathPorts = (path: InstancePath, ports: readonly PortDefinition[]) =>
      new Set(ports.filter(port => highlight.ports.has(signalPortKey({ instancePath: path, portId: port.id }))).map(port => port.id));
    const projected: DeviceNode[] = module.instances.map((instance, index) => {
      const id = nodeId(instance.id);
      const path = [...modulePath, instance.id];
      const saved = positions.get(JSON.stringify(path));
      const position = saved ? { x: saved.x, y: saved.y }
        : { x: 260 * (index % 3) + (module.ports.length ? 260 : 25), y: 240 * Math.floor(index / 3) + 25 };
      const ports = definitions.get(instance.definitionId)!.ports;
      return { id, ariaLabel: instance.name, type: 'device', position, selected: selected === JSON.stringify(path),
        data: { name: instance.name, ports, foldedPath: highlight.folded.has(instance.id), pathPorts: pathPorts(path, ports) } };
    });
    return projected;
  }, [project.layout?.topology, module, modulePath, definitions, selected, highlight]);
  const [devices, setNodes, applyCanvasChanges] = useNodesState(projectedNodes);

  useLayoutEffect(() => {
    setNodes(current => {
      if (current === projectedNodes) return current;
      const measurements = new Map(current.map(node => [node.id, node.measured]));
      // Keep React Flow's measurements across project edits and selection changes.
      return projectedNodes.map(node => ({ ...node, measured: measurements.get(node.id) }));
    });
  }, [projectedNodes, setNodes]);

  const nodes: CanvasNode[] = modulePath.length || module.ports.length ? [
    moduleFrame(devices, { name: moduleName, ports: module.ports,
      pathPorts: new Set(module.ports.filter(port => highlight.ports.has(signalPortKey({
        instancePath: modulePath, portId: port.id,
      }))).map(port => port.id)) }),
    ...devices,
  ] : devices;

  const edges: Edge[] = (module.connections ?? []).map(item => ({
    id: canvasEdgeKey('connection', item.id), source: nodeId(item.from.instanceId), target: nodeId(item.to.instanceId),
    sourceHandle: handleId(item.from.portId), targetHandle: handleId(item.to.portId),
    label: item.mediaKind && mediaLabels[item.mediaKind],
    ariaLabel: `连线：${portDisplayName(item.from.portId)} → ${portDisplayName(item.to.portId)}`,
  }));
  for (const mapping of module.portMappings ?? []) {
    const outward = module.ports.find(port => port.id === mapping.portId)?.direction === 'out';
    const inner = { id: nodeId(mapping.target.instanceId), handle: handleId(mapping.target.portId) };
    const outer = { id: boundary, handle: handleId(mapping.portId) };
    const [from, to] = outward ? [inner, outer] : [outer, inner];
    edges.push({ id: canvasEdgeKey('mapping', mapping.portId), source: from.id, target: to.id,
      sourceHandle: from.handle, targetHandle: to.handle, ariaLabel: `公开端口映射：${portDisplayName(mapping.portId)}`, style: { strokeDasharray: '6 4' } });
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
        ariaLabel: `纤芯：${bundle.id} · ${core.id}`,
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
    <div ref={canvas} className="v1-topology-canvas" aria-label="逻辑拓扑画布">
      <ReactFlow<CanvasNode, Edge> nodes={nodes} edges={edges.map(edge => highlight.edges.has(edge.id)
        ? { ...edge, className: 'v1-path-edge', style: { ...edge.style, stroke: '#a85618', strokeWidth: 3 }, zIndex: 2 } : edge)}
        nodeTypes={nodeTypes} ariaLabelConfig={flowAriaLabels} fitView fitViewOptions={canvasFitOptions(treeHidden)}
        viewport={viewport} onViewportChange={changeViewport} onInit={instance => { flow.current = instance; }}
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
          // Drag and measurement events update the canvas only, until the drop commits a project edit.
          const canvasChanges = changes.filter((change): change is Extract<NodeChange<DeviceNode>, { type: 'dimensions' | 'position' }> =>
            (change.type === 'dimensions' && change.id !== boundary)
            || (change.type === 'position' && (change.dragging || devices.some(node => node.id === change.id && node.dragging))));
          if (canvasChanges.length) applyCanvasChanges(canvasChanges);
        }}
        onNodeDragStop={(_, node) => {
          const instance = instances.get(node.id);
          const previous = projectedNodes.find(item => item.id === node.id)?.position;
          if (instance && previous && (node.position.x !== previous.x || node.position.y !== previous.y)) {
            move(instance.id, node.position);
          }
        }}>
        <Background />
        <CanvasControls treeHidden={treeHidden} />
      </ReactFlow>
      {!nodes.length && <span className="v1-topology-empty">添加实例或声明公开端口以开始。</span>}
    </div>
  );
}
