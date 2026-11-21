import { Background, ConnectionMode, ReactFlow, ReactFlowProvider, useStoreApi, useUpdateNodeInternals } from '@xyflow/react';
import type { Connection as FlowConnection, Node, NodeProps, OnConnectStartParams, ReactFlowInstance, Rect, Viewport, XYPosition } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ResolvedInstance } from '../../../engine/v1/hierarchy';
import type { PathResult } from '../../../engine/v1/path-resolver';
import { signalPortKey } from '../../../engine/v1/signal-graph';
import { libraryDragType, readLibraryItem } from '../../../library/v1/insert-library-item';
import type { LibraryItem } from '../../../library/v1/insert-library-item';
import type { WiringSelection } from '../../../state/v1/remove-topology-object';
import type { Connection } from '../../../model/v1/topology';
import type { InstancePath, PortDefinition, PortMapping, Project } from '../../../model/v1/types';
import { structureScope } from '../../../workbench/v1/structure-scope';
import { BlockPorts } from './block-ports';
import { frameHeader, frameInsets, ModuleFrame } from './module-frame';
import { keepNodeInside, moduleExtent } from './frame-geometry';
import { FrameResizeHandles } from './frame-resize-handles';
import { keepGraphVisible } from './viewport';
import { CanvasControls, canvasFitOptions, flowAriaLabels } from './canvas-controls';
import { hierarchyKey } from './hierarchy-view';
import { projectPathHighlight } from './path-highlight';
import type { BudgetHighlight } from './path-highlight';
import { projectTopology, toLocalPosition } from './topology-projection';
import { handleId, nodeId, portKey, projectWiring, scopedWiringProblem } from './topology-wiring';
import type { WiringEdge } from './topology-wiring';
import '@xyflow/react/dist/style.css';

type NodeData = {
  key: string;
  path: InstancePath;
  name: string;
  ports: readonly PortDefinition[];
  pathPorts: ReadonlySet<string>;
  foldedPath?: boolean;
  toggle?: () => void;
  openPort: (id: string) => void;
  wireState?: (id: string, inner?: boolean) => 'origin' | 'target' | undefined;
};
type DeviceNode = Node<NodeData, 'device'>;
type FrameNode = Node<NodeData & {
  outerHandles: boolean;
  locations: readonly string[];
  resize?: Parameters<typeof FrameResizeHandles>[0];
}, 'moduleFrame'>;
type CanvasNode = DeviceNode | FrameNode;

function ExpandButton({ data, expanded }: { data: NodeData; expanded: boolean }) {
  const label = `${expanded ? '收起' : '展开'}模块 ${data.name}`;
  return data.toggle && <button type="button" className="v1-module-toggle nodrag nopan" aria-expanded={expanded}
    aria-label={label} title={label} onDoubleClick={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); data.toggle?.(); }}>{expanded ? '−' : '+'}</button>;
}

function Device({ id, data, selected }: NodeProps<DeviceNode>) {
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => updateInternals(id), [id, data.ports, data.foldedPath, updateInternals]);
  return <div className={`v1-topology-device${selected ? ' is-selected' : ''}${data.foldedPath ? ' has-folded-path' : ''}`}>
    <div className="v1-block-title"><strong>{data.name}</strong><ExpandButton data={data} expanded={false} /></div>
    {data.foldedPath && <span className="v1-topology-path-label">路径经过内部</span>}
    <BlockPorts ports={data.ports} highlighted={data.pathPorts} handleId={handleId} editable wireState={data.wireState} openPort={data.openPort} />
  </div>;
}

function Frame({ id, data, selected }: NodeProps<FrameNode>) {
  return <>
    <ModuleFrame id={id} name={data.name} ports={data.ports} highlighted={data.pathPorts} handleId={handleId}
      editable outerHandles={data.outerHandles} selected={selected} wireState={data.wireState} openPort={data.openPort}
      controls={<>
        {data.locations.length > 0 && <span className="v1-inline-shared" title={data.locations.join('、')}
          aria-label={`共享结构会应用到 ${data.locations.join('、')}`}>共享 · {data.locations.length} 处</span>}
        <ExpandButton data={data} expanded />
      </>} />
    {data.resize && <FrameResizeHandles {...data.resize} />}
  </>;
}

const nodeTypes = { device: Device, moduleFrame: Frame };

type Props = {
  project: Project;
  instances: readonly ResolvedInstance[];
  modulePath: InstancePath;
  selectedInstance?: InstancePath;
  groupMode: boolean;
  groupPaths: readonly InstancePath[];
  changeGroupSelection: (paths: readonly InstancePath[], active?: boolean) => void;
  pathResult?: PathResult;
  budgetHighlight?: BudgetHighlight;
  expanded: ReadonlySet<string>;
  toggleModule: (path: InstancePath) => void;
  openPort: (path: InstancePath, portId: string) => void;
  selectInstance: (path?: InstancePath) => void;
  enterModule: (path: InstancePath) => void;
  move: (path: InstancePath, position: XYPosition, frame?: Rect) => void;
  resize: (frame: Rect, placementAdjustments: readonly { path: InstancePath; position: XYPosition }[]) => void;
  connect: (scope: InstancePath, connection: Omit<Connection, 'id'>) => void;
  mapPort: (scope: InstancePath, mapping: PortMapping) => void;
  add: (item: LibraryItem, position: XYPosition) => boolean;
  deleteSelection: (path: InstancePath, instanceId?: string, wire?: WiringSelection) => boolean;
  rename: () => void;
  report: (message: string) => void;
  undo: () => void;
  redo: () => void;
};

export function TopologyCanvas(props: Props) {
  return <ReactFlowProvider><EditableTopologyCanvas {...props} /></ReactFlowProvider>;
}

function EditableTopologyCanvas({ project, instances, modulePath, selectedInstance, pathResult, budgetHighlight, expanded, toggleModule, selectInstance,
  enterModule, move, resize, connect, mapPort, add, deleteSelection, rename, report, undo, redo, openPort,
  groupMode, groupPaths, changeGroupSelection }: Props) {
  const flowStore = useStoreApi();
  const boxSelection = useRef<Set<string> | undefined>(undefined);
  const grouped = new Set(groupPaths.map(hierarchyKey));
  const [wireStart, setWireStart] = useState<string>();
  const cancelled = useRef(false);
  const connected = useRef(false);
  const [viewport, setViewport] = useState<Viewport>();
  const [resizePreview, setResizePreview] = useState<Rect>();
  const [measured, setMeasured] = useState<ReadonlyMap<string, { width: number; height: number }>>(new Map());
  const [drag, setDrag] = useState<{ key: string; position: XYPosition }>();
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string>();
  const canvas = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<CanvasNode, WiringEdge>>(null);

  const projection = useMemo(() => projectTopology(project, instances, modulePath, expanded, measured, resizePreview),
    [project, instances, modulePath, expanded, measured, resizePreview]);
  const { nodes: items, rootKey, nodeByKey, scopes } = projection;
  const highlights = useMemo(() => new Map([...scopes].map(([key, { path }]) =>
    [key, projectPathHighlight(pathResult, path, budgetHighlight)])), [scopes, pathResult, budgetHighlight]);
  const { ports, edges } = useMemo(() => projectWiring(projection, highlights), [projection, highlights]);

  const changeViewport = useCallback((requested: Viewport) => {
    const displayed = flow.current?.getNodes() ?? [];
    const bounds = displayed.filter(node => node.data.key !== rootKey || displayed.length === 1).flatMap(({ id, type }) => {
      const node = flow.current?.getInternalNode(id);
      const width = node?.measured.width ?? 0;
      const height = node?.measured.height ?? 0;
      if (!node || width <= 0 || height <= 0) return [];
      // A blank area inside a large frame should not count as a visible node.
      return [{ ...node.internals.positionAbsolute,
        width: type === 'moduleFrame' ? Math.min(width, 320) : width,
        height: type === 'moduleFrame' ? Math.min(height, frameHeader) : height }];
    });
    const next = keepGraphVisible(requested, canvas.current?.clientWidth ?? 0, canvas.current?.clientHeight ?? 0, bounds);
    setViewport(next);
  }, [rootKey]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (flow.current) changeViewport(flow.current.getViewport());
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, changeViewport]);

  const fromPort = wireStart ? ports.get(wireStart) : undefined;
  function wireState(node: string, portId: string, inner = false) {
    const key = portKey(node, handleId(portId, inner));
    if (wireStart === key) return 'origin';
    if (fromPort && !scopedWiringProblem(fromPort, ports.get(key))) return 'target';
  }

  function connectionPorts(edge: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) {
    return [ports.get(portKey(edge.source, edge.sourceHandle)), ports.get(portKey(edge.target, edge.targetHandle))] as const;
  }

  function onConnect(edge: FlowConnection) {
    if (cancelled.current) return;
    const [a, b] = connectionPorts(edge);
    if (!a || !b || scopedWiringProblem(a, b)) return;
    connected.current = true;
    const [source, target] = a.direction === 'out' ? [a, b] : [b, a];
    if (source.endpoint && target.endpoint) connect(a.scope, { from: source.endpoint, to: target.endpoint });
    else if (a.endpoint) mapPort(a.scope, { portId: b.port.id, target: a.endpoint });
    else if (b.endpoint) mapPort(a.scope, { portId: a.port.id, target: b.endpoint });
  }

  function cancelWiring() {
    cancelled.current = true;
    flowStore.getState().cancelConnection();
    flowStore.setState({ connectionClickStartHandle: null });
    setWireStart(undefined);
  }

  function startWiring(_event: MouseEvent | TouchEvent, { nodeId, handleId }: OnConnectStartParams) {
    if (!nodeId || !handleId) return;
    cancelled.current = false;
    connected.current = false;
    report('');
    setWireStart(portKey(nodeId, handleId));
  }

  const active = selectedInstance && hierarchyKey(selectedInstance);
  const selectedNode = active && nodeByKey.get(active);
  const selectedWiring = !selectedNode && edges.find(edge => edge.id === selectedEdgeKey);
  useEffect(() => { if (selectedInstance) setSelectedEdgeKey(undefined); }, [selectedInstance]);

  const deepest = items.reduce((max, node) => Math.max(max, node.item.instancePath.length), modulePath.length);
  const selectedBranch = selectedInstance?.[modulePath.length];
  const nodes: CanvasNode[] = items.map(node => {
    const { item, key, parentKey, frame } = node;
    const path = item.instancePath;
    const boundary = key === rootKey;
    const parentHighlight = highlights.get(hierarchyKey(path.slice(0, -1)));
    const highlight = boundary ? highlights.get(rootKey) : parentHighlight;
    const { definition } = item;
    const name = item.instance?.name ?? definition.name;
    const id = nodeId(key);
    const data: NodeData = { key, path, name, ports: definition.ports,
      pathPorts: new Set(definition.ports.filter(port =>
        highlight?.ports.has(signalPortKey({ instancePath: path, portId: port.id }))).map(port => port.id)),
      foldedPath: !frame && !!item.instance && parentHighlight?.folded.has(item.instance.id),
      wireState: wireStart ? (port, inner) => wireState(id, port, inner) : undefined,
      openPort: portId => { cancelWiring(); openPort(path, portId); },
      toggle: !boundary && definition.kind === 'module' ? () => {
        cancelWiring();
        setSelectedEdgeKey(undefined);
        toggleModule(path);
      } : undefined,
    };
    const placement = { id, ariaLabel: name, position: drag?.key === key ? drag.position : node.position,
      parentId: parentKey === undefined ? undefined : nodeId(parentKey), selected: (active === key || grouped.has(key)) && !boundary };
    // Keep sibling blocks accessible where an expanded branch overlaps their stored positions.
    // React Flow drops internal measurements when a controlled node is replaced.
    if (!frame) return { ...placement, type: 'device', measured: measured.get(key),
      zIndex: 2 + (deepest - path.length) * 2 + Number(path[modulePath.length] === selectedBranch), data };
    const direct = scopes.get(key)?.members ?? [];
    return { ...placement, type: 'moduleFrame', draggable: !boundary && !groupMode, dragHandle: '.v1-frame-title',
      selectable: !boundary, focusable: !boundary, zIndex: path.length - deepest - 2,
      measured: { width: frame.display.width, height: frame.display.height },
      style: { width: frame.display.width, height: frame.display.height, pointerEvents: 'none' },
      data: { ...data, outerHandles: !boundary, locations: boundary ? [] : structureScope(instances, definition.id),
        resize: boundary ? {
          frame: frame.display, insets: frameInsets(definition.ports), preview: setResizePreview,
          childrenBounds: direct.map(child => child.frame ? { ...child.bounds,
            width: child.frame.display.width, height: child.frame.display.height } : child.bounds),
          finish: next => resize(next, direct.filter(child =>
            child.preferred.x !== child.bounds.x || child.preferred.y !== child.bounds.y)
            .map(child => ({ path: child.item.instancePath, position: child.bounds }))),
        } : undefined,
      },
    };
  });

  function clampPosition(key: string, position: XYPosition) {
    const node = nodeByKey.get(key)!;
    const parentKey = hierarchyKey(node.item.instancePath.slice(0, -1));
    const parent = nodeByKey.get(parentKey);
    const local = toLocalPosition(position, node.offset);
    return parent?.frame ? keepNodeInside({ ...node.bounds, ...local },
      moduleExtent(parent.frame.base, frameInsets(parent.item.definition.ports))) : local;
  }

  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (event.defaultPrevented || canvas.current?.closest('[inert]') || document.querySelector('dialog[open]')) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) return;
      if (event.key === 'Escape' && wireStart) {
        event.preventDefault();
        cancelWiring();
        report('');
      } else if (event.key === 'Escape' && groupMode) {
        event.preventDefault();
        changeGroupSelection([], false);
      } else if (event.key === 'F2' && selectedNode && selectedNode.key !== rootKey) {
        event.preventDefault();
        rename();
      } else if (event.key === 'Delete') {
        if (selectedNode && selectedNode.key !== rootKey) {
          event.preventDefault();
          const path = selectedNode.item.instancePath;
          deleteSelection(path.slice(0, -1), path.at(-1));
        } else if (selectedWiring && selectedWiring.data) {
          event.preventDefault();
          if (deleteSelection(selectedWiring.data.scope, undefined, selectedWiring.data)) setSelectedEdgeKey(undefined);
        }
      } else if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        if (key === 'z' || key === 'y') {
          event.preventDefault();
          if (event.shiftKey || key === 'y') redo();
          else undo();
        }
      }
    }
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  });

  return <div ref={canvas} className="v1-topology-canvas" aria-label="逻辑拓扑画布"
    onDragOver={event => {
      if (!event.dataTransfer.types.includes(libraryDragType)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }}
    onDrop={event => {
      if (!event.dataTransfer.types.includes(libraryDragType)) return;
      event.preventDefault();
      const item = readLibraryItem(event.dataTransfer);
      if (item && flow.current) add(item, flow.current.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    }}>
    <ReactFlow<CanvasNode, WiringEdge> nodes={nodes} edges={edges.map(edge => ({ ...edge, selected: selectedWiring === edge }))}
      nodeTypes={nodeTypes} ariaLabelConfig={flowAriaLabels} fitView fitViewOptions={canvasFitOptions}
      viewport={viewport} onViewportChange={changeViewport} onInit={instance => { flow.current = instance; }}
      minZoom={0.001} maxZoom={2} deleteKeyCode={null} connectionMode={ConnectionMode.Loose}
      zIndexMode="manual" nodesDraggable={!groupMode} selectionOnDrag={groupMode} panOnDrag={groupMode ? [1, 2] : true}
      onSelectionStart={() => {
        cancelWiring();
        setSelectedEdgeKey(undefined);
        boxSelection.current = new Set(nodes.filter(node => node.selected).map(node => node.data.key));
      }}
      onSelectionEnd={() => {
        const keys = boxSelection.current;
        boxSelection.current = undefined;
        if (keys) changeGroupSelection(items.filter(item => item.key !== rootKey && keys.has(item.key)).map(item => item.item.instancePath));
        queueMicrotask(() => flowStore.setState({ nodesSelectionActive: false }));
      }}
      connectionLineStyle={cancelled.current ? { opacity: 0 } : undefined}
      isValidConnection={edge => !cancelled.current && !scopedWiringProblem(...connectionPorts(edge))}
      onConnect={onConnect} onConnectStart={startWiring} onClickConnectStart={startWiring}
      onConnectEnd={(_, result) => {
        if (!cancelled.current && result.toHandle && !result.isValid) {
          const end = ports.get(portKey(result.toHandle.nodeId, result.toHandle.id));
          report(scopedWiringProblem(fromPort, end) ?? '');
        }
        setWireStart(undefined);
      }}
      onClickConnectEnd={event => {
        const target = !connected.current && event.target instanceof Element && event.target.closest('.react-flow__handle');
        if (target) {
          const end = ports.get(portKey(target.getAttribute('data-nodeid') ?? '', target.getAttribute('data-handleid')));
          report(scopedWiringProblem(fromPort, end) ?? '');
        }
        setWireStart(undefined);
      }}
      onPaneClick={() => {
        cancelWiring(); setSelectedEdgeKey(undefined); selectInstance(); report('');
        if (groupMode) changeGroupSelection([]);
      }}
      onEdgeClick={(_, edge) => { if (!groupMode) { cancelWiring(); selectInstance(); setSelectedEdgeKey(edge.id); report(''); } }}
      onNodeClick={(event, node) => {
        if (node.data.key === rootKey || (event.target instanceof Element && event.target.closest('.react-flow__handle'))) return;
        cancelWiring();
        setSelectedEdgeKey(undefined);
        if (groupMode || event.ctrlKey || event.metaKey) {
          const initial = groupMode ? groupPaths : selectedInstance ? [selectedInstance] : [];
          const picked = initial.some(path => hierarchyKey(path) === node.data.key);
          changeGroupSelection(picked ? initial.filter(path => hierarchyKey(path) !== node.data.key) : [...initial, node.data.path]);
        } else selectInstance(node.data.path);
        report('');
      }}
      onNodeDoubleClick={(event, node) => {
        if (event.target instanceof Element && event.target.closest('.react-flow__handle')) return;
        if (!groupMode && node.data.toggle) enterModule(node.data.path);
      }}
      onNodesChange={changes => {
        for (const change of changes) {
          if (change.type !== 'select' || !boxSelection.current) continue;
          const key = decodeURIComponent(change.id);
          if (change.selected) boxSelection.current.add(key);
          else boxSelection.current.delete(key);
        }
        const dimensions = changes.flatMap(change => {
          if (change.type !== 'dimensions' || !change.dimensions) return [];
          const key = decodeURIComponent(change.id);
          const item = nodeByKey.get(key);
          return item && !item.frame ? [{ key, ...change.dimensions }] : [];
        });
        if (dimensions.length) setMeasured(current => {
          let next: Map<string, { width: number; height: number }> | undefined;
          for (const { key, width, height } of dimensions) {
            const before = current.get(key);
            if (before?.width === width && before.height === height) continue;
            (next ??= new Map(current)).set(key, { width, height });
          }
          return next ?? current;
        });
      }}
      onNodeDrag={(_, node) => {
        const projected = nodeByKey.get(node.data.key);
        if (!projected) return;
        const position = clampPosition(projected.key, node.position);
        setDrag({ key: projected.key, position: { x: position.x - projected.offset.x, y: position.y - projected.offset.y } });
      }}
      onNodeDragStop={(_, node) => {
        setDrag(undefined);
        const projected = nodeByKey.get(node.data.key);
        if (!projected || !node.data.path.length) return;
        const position = clampPosition(projected.key, node.position);
        const { bounds } = projected;
        if (position.x !== bounds.x || position.y !== bounds.y) {
          const frame = nodeByKey.get(hierarchyKey(node.data.path.slice(0, -1)))?.frame;
          move(node.data.path, position, frame && !frame.saved ? frame.base : undefined);
        }
      }}>
      <Background />
      <CanvasControls canLocate={!!(selectedNode || selectedWiring)} locate={() => {
        const ids = selectedNode ? [nodeId(selectedNode.key)] : selectedWiring ? [selectedWiring.source, selectedWiring.target] : [];
        if (ids.length) void flow.current?.fitView({ ...canvasFitOptions, maxZoom: 1.2, nodes: ids.map(id => ({ id })) });
      }} />
    </ReactFlow>
    {!scopes.get(rootKey)?.members.length && <span className="v1-topology-empty">从器件库添加器件，或声明对外端口。</span>}
  </div>;
}
