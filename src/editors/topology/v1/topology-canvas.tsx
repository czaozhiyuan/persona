import { wireRouteKey } from '../../../model/v1/wire-route';
import { createPortal } from 'react-dom';
import { Background, ConnectionMode, ReactFlow, ReactFlowProvider, useKeyPress, useStoreApi, useUpdateNodeInternals, ViewportPortal } from '@xyflow/react';
import type { Connection as FlowConnection, CoordinateExtent, Node, NodeProps, OnConnectStartParams, ReactFlowInstance, Rect, Viewport, XYPosition } from '@xyflow/react';
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ResolvedInstance } from '../../../engine/v1/hierarchy';
import type { PathResult } from '../../../engine/v1/path-resolver';
import { signalPortKey } from '../../../engine/v1/signal-graph';
import type { MultiplexPower } from '../../../engine/v1/multiplex-power';
import { multiplexCaption, MultiplexDetails } from '../../../workbench/v1/budgets/multiplex-details';
import { blankModuleId } from '../../../library/v1/built-in';
import { libraryDragType, readLibraryItem } from '../../../library/v1/insert-library-item';
import type { LibraryItem } from '../../../library/v1/insert-library-item';
import { moveWiringSummary, planInstanceMoves } from '../../../state/v1/reparent-instance';
import { defaultTopologyPosition } from '../../../state/v1/topology-position';
import type { WiringSelection } from '../../../state/v1/remove-topology-object';
import type { Connection } from '../../../model/v1/topology';
import type { EndpointRef, InstancePath, PortDefinition, PortMapping, Project, TopologyFrame, TopologyPlacement } from '../../../model/v1/types';
import { createPathNames, structureScope } from '../../../workbench/v1/structure-scope';
import { BlockPorts } from './block-ports';
import { definitionIcon, DeviceIcon, type DeviceIconKey } from './device-icon';
import { frameInsets, ModuleFrame, type FramePortHeights } from './module-frame';
import { canConnect } from '../../../model/v1/types';
import { keepNodeInside, moduleExtent } from './frame-geometry';
import { ModulePlacement } from './module-placement';
import { FrameResizeHandles } from './frame-resize-handles';
import { keepGraphVisible } from './viewport';
import { CanvasControls, canvasFitOptions, flowAriaLabels } from './canvas-controls';
import type { CanvasView, ExpansionDepth } from './canvas-controls';
import { hierarchyKey, sharedParent } from './hierarchy-view';
import { projectPathHighlight } from './path-highlight';
import { captionNotes } from './link-annotations';
import type { Annotation } from './link-annotations';
import type { BudgetHighlight } from './path-highlight';
import { estimatedBlockSize, projectTopology } from './topology-projection';
import type { FrameResizePreview, TopologyItem } from './topology-projection';
import { groupDragBounds, groupDragExtent, groupDropDelta, placeDropGroup, reparentDropTarget } from './reparent-drop';
import type { ApprovedMove, ReparentLayout } from './reparent-drop';
import { handleId, nodeId, portKey, projectWiring, scopedWiringProblem } from './topology-wiring';
import type { WiringEdge } from './topology-wiring';
import type { CenterPlacement } from './topology-layout-edits';
import { preserveDeletionLayout } from './topology-layout-edits';
import { planInlineExpansion } from './inline-expansion-layout';
import { SignalWire, signalColor } from './signal-wire';
import '@xyflow/react/dist/style.css';

type NodeData = {
  key: string;
  path: InstancePath;
  name: string;
  iconKey: DeviceIconKey;
  ports: readonly PortDefinition[];
  labelContext: ResolvedInstance;
  pathPorts: ReadonlySet<string>;
  portValue?: (id: string) => string | undefined;
  notes?: Annotation[];
  foldedPath?: boolean;
  toggle?: () => void;
  openPort: (id: string) => void;
  addPort?: () => void;
  newPortId?: string;
  wireState?: (id: string, inner?: boolean) => 'origin' | 'target' | undefined;
};
type DeviceNode = Node<NodeData, 'device'>;
type FrameNode = Node<NodeData & {
  onPortHeight: (key: string, height: FramePortHeights) => void;
  outerHandles: boolean;
  locations: readonly string[];
  resize: Parameters<typeof FrameResizeHandles>[0];
}, 'moduleFrame'>;
type CanvasNode = DeviceNode | FrameNode;
type DropPreview = NonNullable<ReturnType<typeof reparentDropTarget>> & {
  plan?: ApprovedMove;
  error?: string;
  label: string;
  selectedCount: number;
};
type DragSession = {
  base: Project;
  preview?: DropPreview;
  anchor: TopologyItem;
  members: readonly TopologyItem[];
  keys: ReadonlySet<string>;
  bounds: Rect;
  extent?: CoordinateExtent;
  frame?: TopologyFrame;
};

function ExpandButton({ data, expanded }: { data: NodeData; expanded: boolean }) {
  const label = `${expanded ? '收起' : '展开'}模块 ${data.name}`;
  return data.toggle && <button type="button" className="v1-module-toggle nodrag nopan" aria-expanded={expanded}
    aria-label={label} title={label} onDoubleClick={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); data.toggle?.(); }}>{expanded ? '−' : '+'}</button>;
}

function AddPortButton({ data }: { data: NodeData }) {
  const label = `端口管理 · ${data.name}`;
  return data.addPort && <button type="button" className="v1-node-add-port nodrag nopan" aria-label={label} title={label} aria-haspopup="dialog"
    onDoubleClick={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); data.addPort?.(); }}>＋端口</button>;
}

function NodeCaption({ notes }: Pick<NodeData, 'notes'>) {
  return notes?.length ? <div className="v1-node-caption" aria-hidden="true">{captionNotes(notes).map(n => n.text).join(' · ')}</div> : null;
}

function Device({ id, data, selected }: NodeProps<DeviceNode>) {
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => updateInternals(id), [id, data.ports, updateInternals]);
  return <div title={data.notes?.map(n => n.detail).join('\n')} className={`v1-topology-device${data.pathPorts.size ? ' is-on-path' : ''}${selected ? ' is-selected' : ''}${data.foldedPath ? ' has-folded-path' : ''}`}>
    <div className="v1-block-title"><DeviceIcon iconKey={data.iconKey} /><strong>{data.name}</strong><AddPortButton data={data} /><ExpandButton data={data} expanded={false} /></div>
    {data.foldedPath && <span className="v1-topology-path-label">路径经过内部</span>}
    <NodeCaption notes={data.notes} />
    <BlockPorts labelContext={data.labelContext} portValue={data.portValue} ports={data.ports} highlighted={data.pathPorts} newPortId={data.newPortId} handleId={handleId} editable wireState={data.wireState} openPort={data.openPort} />
  </div>;
}

function Frame({ id, data, selected, width, height }: NodeProps<FrameNode>) {
  return <>
    <ModuleFrame frameKey={data.key} insets={data.resize.insets} onPortHeight={data.onPortHeight} labelContext={data.labelContext} iconKey={data.iconKey} metricTitle={data.notes?.map(n => n.detail).join('\n')} portValue={data.portValue} id={id} width={width} height={height} name={data.name} ports={data.ports} highlighted={data.pathPorts} newPortId={data.newPortId} handleId={handleId}
      editable outerHandles={data.outerHandles} selected={selected} wireState={data.wireState} openPort={data.openPort}
      controls={<>
        {data.locations.length > 0 && <span className="v1-inline-shared" title={data.locations.join('、')}
          aria-label={`共享结构会应用到 ${data.locations.join('、')}`}>共享 · {data.locations.length} 处</span>}
        <AddPortButton data={data} />
        <ExpandButton data={data} expanded />
      </>} />
    <NodeCaption notes={data.notes} />
    {data.resize && <FrameResizeHandles {...data.resize} />}
  </>;
}

const nodeTypes = { device: Device, moduleFrame: Frame };
const edgeTypes = { signal: SignalWire };

type Props = {
  multiplex: MultiplexPower;
  project: Project;
  instances: readonly ResolvedInstance[];
  modulePath: InstancePath;
  selectedInstance?: InstancePath;
  onAddPort: (path: InstancePath) => void;
  newPort?: EndpointRef;
  selectedPaths: readonly InstancePath[];
  selectObject: (path: InstancePath, extend: boolean) => void;
  selectObjects: (paths: readonly InstancePath[]) => void;
  pathResult?: PathResult;
  budgetHighlight?: BudgetHighlight;
  expanded: ReadonlySet<string>;
  toggleModule: (path: InstancePath) => void;
  openPort: (path: InstancePath, portId: string) => void;
  enterModule: (path: InstancePath) => void;
  reparent: (base: Project, plan: ApprovedMove, layout?: ReparentLayout) => void;
  focusMoved?: InstancePath;
  depth: ExpansionDepth;
  viewHost: HTMLDivElement | null;
  topologyActive: boolean;
  fullPage: boolean;
  toggleFullPage: (view: CanvasView) => void;
  restoreView?: CanvasView;
  move: (placements: readonly TopologyPlacement[], frame?: TopologyFrame) => void;
  resize: (frame: TopologyFrame, placementAdjustments: readonly TopologyPlacement[]) => void;
  saveExpansion: (layout: ReturnType<typeof planInlineExpansion>) => void;
  connect: (scope: InstancePath, connection: Omit<Connection, 'id'>) => void;
  mapPort: (scope: InstancePath, mapping: PortMapping) => void;
  placingModule: boolean;
  cancelPlacement: () => void;
  add: (item: LibraryItem, position: XYPosition) => boolean;
  deleteInstances: (paths: readonly InstancePath[], preserve: (project: Project, parentIds: ReadonlySet<string>) => Project) => void;
  route: (scope: InstancePath, wire: WiringSelection, point?: XYPosition) => void;
  deleteWiring: (path: InstancePath, wire: WiringSelection) => boolean;
  rename: () => void;
  copyModule: () => boolean;
  centerPlacement: React.Ref<CenterPlacement>;
  pasteModule: (placement: (ports: readonly PortDefinition[]) => XYPosition | undefined) => boolean;
  report: (message: string) => void;
  undo: () => void;
  redo: () => void;
};

export function TopologyCanvas(props: Props) {
  return <ReactFlowProvider><EditableTopologyCanvas {...props} /></ReactFlowProvider>;
}

function EditableTopologyCanvas({ multiplex, project, instances, modulePath, selectedInstance, selectedPaths, pathResult, budgetHighlight, expanded,
  toggleModule, selectObject, selectObjects, enterModule, reparent, focusMoved, move, resize, connect, mapPort, add, placingModule, cancelPlacement,
  deleteInstances, deleteWiring, route, rename, copyModule, pasteModule, centerPlacement, report, undo, redo, openPort, onAddPort, newPort,
  depth, fullPage, toggleFullPage, restoreView, viewHost, topologyActive, saveExpansion }: Props) {
  const flowStore = useStoreApi<CanvasNode, WiringEdge>();
  const boxSelection = useRef<readonly InstancePath[] | undefined>(undefined);
  const panWithSpace = useKeyPress('Space', { actInsideInputWithModifier: false });
  const selectedKeys = new Set(selectedPaths.map(hierarchyKey));
  const mixedSelection = selectedPaths.length > 1 && !sharedParent(selectedPaths);
  const [wireStart, setWireStart] = useState<string>();
  const cancelled = useRef(false);
  const connected = useRef(false);
  const [initialViewport] = useState(() => restoreView?.viewport);
  const [viewport, setViewport] = useState<Viewport | undefined>(initialViewport);
  const appliedView = useRef<CanvasView>(undefined);
  const [resizePreview, setResizePreview] = useState<FrameResizePreview>();
  const [measured, setMeasured] = useState<ReadonlyMap<string, { width: number; height: number }>>(new Map());
  const [portHeights, setPortHeights] = useState<ReadonlyMap<string, FramePortHeights>>(new Map());
  const onPortHeight = useCallback((key: string, height: FramePortHeights) => {
    setPortHeights(previous => {
      const old = previous.get(key);
      return old?.side === height.side && old.top === height.top ? previous : new Map(previous).set(key, height);
    });
  }, []);
  const dragSession = useRef<DragSession | undefined>(undefined);
  const [dropPreview, setDropPreview] = useState<DropPreview>();
  const renderedPreview = useRef<DropPreview | undefined>(undefined);
  useLayoutEffect(() => { renderedPreview.current = dropPreview; }, [dropPreview]);
  const [drag, setDrag] = useState<ReadonlyMap<string, XYPosition>>();
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | undefined>(() => restoreView?.edgeId);
  const canvas = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<CanvasNode, WiringEdge>>(null);

  const projection = useMemo(() => projectTopology(project, instances, modulePath, expanded, measured, resizePreview, portHeights),
    [project, instances, modulePath, expanded, measured, resizePreview, portHeights]);
  const { nodes: items, rootKey, nodeByKey, scopes } = projection;
  const previousFrames = useRef(new Set<string>());
  const pendingExpansion = useRef(new Set<string>());
  useLayoutEffect(() => {
    const visible = new Set(scopes.keys());
    visible.delete(rootKey);
    const pending = pendingExpansion.current;
    for (const key of visible) if (!previousFrames.current.has(key)) pending.add(key);
    for (const key of pending) if (!visible.has(key)) pending.delete(key);
    previousFrames.current = visible;
    if (!pending.size || !topologyActive) return;
    // The newly revealed cards and multiline frame ports need their real canvas dimensions.
    if (items.some(node => node.frame ? !portHeights.has(node.key) : !measured.has(node.key))) return;
    const layout = planInlineExpansion(projection, pending);
    pending.clear();
    if (layout.moves.length || layout.frames.length) saveExpansion(layout);
  }, [projection, items, scopes, rootKey, topologyActive, portHeights, measured, saveExpansion]);
  // An empty scope has nothing to fit. A queued fit would zoom to its first insertion.
  const [fitInitialNodes] = useState(() => !initialViewport && items.length > 0);
  useEffect(() => {
    if (!focusMoved) return;
    const id = nodeId(hierarchyKey(focusMoved));
    const frame = requestAnimationFrame(() => {
      if (flow.current?.getNode(id)) void flow.current.fitView({ ...canvasFitOptions, nodes: [{ id }], maxZoom: 1.2 });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusMoved]);
  const highlights = useMemo(() => new Map([...scopes].map(([key, { path }]) =>
    [key, projectPathHighlight(pathResult, path, budgetHighlight)])), [scopes, pathResult, budgetHighlight]);
  const { ports, edges } = useMemo(() => projectWiring(projection, highlights), [projection, highlights]);

  const routes = useMemo(() => new Map(project.layout?.topologyWireRoutes?.map(r => [wireRouteKey(r.modulePath, r.wire), r])),
    [project.layout?.topologyWireRoutes]);

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
        height: type === 'moduleFrame' ? Math.min(height, frameInsets(node.data.ports, portHeights.get(node.data.key)).top) : height }];
    });
    const next = keepGraphVisible(requested, canvas.current?.clientWidth ?? 0, canvas.current?.clientHeight ?? 0, bounds);
    setViewport(next);
  }, [rootKey, portHeights]);

  useLayoutEffect(() => {
    if (restoreView && appliedView.current !== restoreView) {
      appliedView.current = restoreView;
      setViewport(restoreView.viewport);
      setSelectedEdgeKey(restoreView.edgeId);
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (flow.current) changeViewport(flow.current.getViewport());
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded, changeViewport, restoreView]);

  const fromPort = wireStart ? ports.get(wireStart) : undefined;
  function wireState(node: string, portId: string, inner = false) {
    const key = portKey(node, handleId(portId, inner));
    if (wireStart === key) return 'origin';
    if (fromPort && !scopedWiringProblem(fromPort, ports.get(key))) return 'target';
  }

  function connectionPorts(edge: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }) {
    return [ports.get(portKey(edge.source, edge.sourceHandle)), ports.get(portKey(edge.target, edge.targetHandle))] as const;
  }

  function wireEndpoints(edge: WiringEdge) {
    return connectionPorts(edge).flatMap(p => p ? [{ instancePath: p.endpoint ? [...p.scope, p.endpoint.instanceId] : p.scope, portId: p.port.id }] : []);
  }

  function onConnect(edge: FlowConnection) {
    if (cancelled.current) return;
    const [a, b] = connectionPorts(edge);
    if (!a || !b || scopedWiringProblem(a, b)) return;
    connected.current = true;
    const [source, target] = canConnect(a.direction, b.direction) ? [a, b] : [b, a];
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
  const selectedWiring = !selectedPaths.length && edges.find(edge => edge.id === selectedEdgeKey);
  const locateIds = selectedWiring ? [selectedWiring.source, selectedWiring.target]
    : selectedPaths.map(hierarchyKey).filter(key => nodeByKey.has(key)).map(nodeId);
  useEffect(() => { if (selectedPaths.length) setSelectedEdgeKey(undefined); }, [selectedPaths.length, selectedInstance]);

  const deepest = items.reduce((max, node) => Math.max(max, node.item.instancePath.length), modulePath.length);
  const selectedBranch = selectedInstance?.[modulePath.length];
  const { showName } = useMemo(() => createPathNames(instances), [instances]);
  const nodes: CanvasNode[] = items.map(node => {
    const { item, key, parentKey, frame } = node;
    const path = item.instancePath;
    const boundary = key === rootKey;
    const parentHighlight = highlights.get(hierarchyKey(path.slice(0, -1)));
    const highlight = boundary ? highlights.get(rootKey) : parentHighlight;
    const { definition } = item;
    const name = showName(path);
    const id = nodeId(key);
    const data: NodeData = { key, path, name, labelContext: item, ports: definition.ports,
      iconKey: definitionIcon(definition),
      portValue: portId => {
        const ref = { instancePath: path, portId };
        return multiplexCaption(multiplex.at(ref)) ?? budgetHighlight?.annotations?.ports.get(signalPortKey(ref));
      },
      notes: budgetHighlight?.annotations?.nodes.get(key),
      pathPorts: new Set(definition.ports.filter(port =>
        highlight?.ports.has(signalPortKey({ instancePath: path, portId: port.id }))).map(port => port.id)),
      foldedPath: !frame && !!item.instance && parentHighlight?.folded.has(item.instance.id),
      wireState: wireStart ? (port, inner) => wireState(id, port, inner) : undefined,
      openPort: portId => { cancelWiring(); openPort(path, portId); },
      addPort: selectedPaths.length < 2 && (active ?? rootKey) === key ? () => { cancelWiring(); onAddPort(path); } : undefined,
      newPortId: newPort && hierarchyKey(newPort.instancePath) === key ? newPort.portId : undefined,
      toggle: !boundary && definition.kind === 'module' ? () => {
        cancelWiring();
        setSelectedEdgeKey(undefined);
        toggleModule(path);
      } : undefined,
    };
    const className = dropPreview?.node?.key === key ? (dropPreview.error ? 'v1-drop-blocked' : 'v1-drop-allowed') : undefined;
    const placement = { id, className, ariaLabel: name, position: drag?.get(key) ?? node.position,
      parentId: parentKey === undefined ? undefined : nodeId(parentKey), selected: selectedKeys.has(key),
      draggable: !boundary && !panWithSpace && !(mixedSelection && selectedKeys.has(key)) };
    // Keep sibling blocks accessible where an expanded branch overlaps their stored positions.
    // React Flow drops internal measurements when a controlled node is replaced.
    if (!frame) return { ...placement, type: 'device', measured: measured.get(key),
      zIndex: 3 + deepest - modulePath.length + (deepest - path.length) * 2 + Number(path[modulePath.length] === selectedBranch), data };
    const direct = scopes.get(key)?.members ?? [];
    const outer = parentKey && nodeByKey.get(parentKey);
    const origin = outer && outer.frame ? moduleExtent(outer.frame.base, outer.frame.insets)[0] : undefined;
    const originLimit = origin ? {
      x: frame.display.x + origin[0] - node.bounds.x,
      y: frame.display.y + origin[1] - node.bounds.y,
    } : undefined;
    return { ...placement, type: 'moduleFrame', dragHandle: '.v1-frame-title',
      selectable: !boundary, focusable: !boundary, zIndex: 2 + path.length - modulePath.length,
      measured: { width: frame.display.width, height: frame.display.height },
      style: { width: frame.display.width, height: frame.display.height, pointerEvents: 'none' },
      data: { ...data, onPortHeight, outerHandles: !boundary, locations: boundary ? [] : structureScope(instances, definition.id),
        resize: {
          frame: frame.display, insets: frame.insets, originLimit,
          preview: next => setResizePreview(next && { key, frame: next }),
          childrenBounds: direct.map(child => child.frame ? { ...child.bounds,
            width: child.frame.display.width, height: child.frame.display.height } : child.bounds),
          finish: (next, original) => {
            const adjustments = direct.filter(child => child.preferred.x !== child.bounds.x || child.preferred.y !== child.bounds.y)
              .map(child => ({ instancePath: child.item.instancePath, x: child.bounds.x, y: child.bounds.y }));
            if (!boundary && (next.x !== original.x || next.y !== original.y)) {
              adjustments.push({ instancePath: path, x: node.bounds.x + next.x - frame.display.x, y: node.bounds.y + next.y - frame.display.y });
            }
            resize({ modulePath: path, ...next }, adjustments);
          },
        },
      },
    };
  });

  // Render frame surfaces below the wires while keeping frame controls and labels above them.
  const frameOrigins = new Map<string, XYPosition>();
  const frameSurfaces = nodes.flatMap(node => {
    if (node.type !== 'moduleFrame') return [];
    const parent = node.parentId ? frameOrigins.get(node.parentId) : undefined;
    const x = (parent?.x ?? 0) + node.position.x;
    const y = (parent?.y ?? 0) + node.position.y;
    frameOrigins.set(node.id, { x, y });
    return [<div key={node.id} className="v1-frame-surface" style={{
      left: x, top: y, width: node.measured?.width, height: node.measured?.height, zIndex: node.zIndex,
    }} />];
  });

  function startDrag(node: CanvasNode, moving: CanvasNode[]) {
    const anchor = nodeByKey.get(node.data.key);
    if (!anchor || !node.data.path.length) return;
    const members = moving.flatMap(item => {
      const projected = nodeByKey.get(item.data.key);
      return projected ? [projected] : [];
    });
    const parentPath = node.data.path.slice(0, -1);
    const parent = nodeByKey.get(hierarchyKey(parentPath));
    const frame = parent?.frame;
    report('');
    // Keep the grabbed node first for placement and post-drop focus.
    const ordered = [anchor, ...members.filter(item => item.key !== anchor.key)];
    const bounds = groupDragBounds(ordered);
    const extent = parent && frame ? groupDragExtent(bounds, moduleExtent(frame.base, frame.insets)) : undefined;
    dragSession.current = { base: project, anchor, members: ordered, keys: new Set(ordered.map(item => item.key)),
      bounds, extent,
      frame: frame && !frame.saved ? { modulePath: parentPath, ...frame.base } : undefined };
    if (!selectedKeys.has(anchor.key)) selectObject(anchor.item.instancePath, false);
  }

  function dragDelta(session: DragSession, position: XYPosition): XYPosition {
    // Clamp the whole bounding box so siblings keep their spacing at the frame edge.
    return groupDropDelta(session.bounds, session.anchor.position, position, session.extent);
  }

  function boundsOf(item: TopologyItem): Rect | undefined {
    const internal = flow.current?.getInternalNode(nodeId(item.key));
    const width = internal?.measured.width, height = internal?.measured.height;
    if (internal && width && height) return { ...internal.internals.positionAbsolute, width, height };
  }

  function expandedFrameAt(point: XYPosition) {
    let hit: TopologyItem | undefined;
    for (const item of items) {
      if (!item.frame || item.key === rootKey
        || (hit && item.item.instancePath.length < hit.item.instancePath.length)) continue;
      const bounds = boundsOf(item);
      if (bounds && point.x >= bounds.x && point.x <= bounds.x + bounds.width
        && point.y >= bounds.y && point.y <= bounds.y + bounds.height) hit = item;
    }
    return hit;
  }

  function pointerOnCanvas(event: MouseEvent | TouchEvent) {
    if (!flow.current || !canvas.current) return;
    const contact = 'clientX' in event ? event : event.touches[0] ?? event.changedTouches[0];
    if (!contact) return;
    const screen = { x: contact.clientX, y: contact.clientY };
    const hit = document.elementFromPoint(screen.x, screen.y);
    if (!hit || !canvas.current.contains(hit) || hit.closest('.v1-canvas-zoom, .react-flow__attribution')) return;
    return flow.current.screenToFlowPosition(screen);
  }

  function targetAt(session: DragSession, point: XYPosition) {
    return reparentDropTarget(session.anchor, items, modulePath, boundsOf, point, 6 / (flow.current?.getZoom() ?? 1), session.keys);
  }

  function previewDrag(event: MouseEvent | TouchEvent, node: CanvasNode) {
    const session = dragSession.current;
    if (!session) return;
    const point = pointerOnCanvas(event);
    const target = point && targetAt(session, point);
    if (!target) {
      if (session.preview) { session.preview = undefined; setDropPreview(undefined); }
    } else if (session.preview?.kind !== target.kind
      || hierarchyKey(session.preview.destination) !== hierarchyKey(target.destination) || session.preview.problem !== target.problem) {
      const owner = target.node?.item ?? instances.find(item => hierarchyKey(item.instancePath) === hierarchyKey(target.destination));
      const checked = target.problem ? undefined
        : planInstanceMoves(session.base, session.members.map(item => item.item.instancePath), target.destination);
      const name = owner?.instance?.name ?? owner?.definition.name ?? '当前模块';
      session.preview = { ...target, selectedCount: session.members.length, plan: checked?.ok ? checked : undefined,
        error: target.problem ?? (checked?.ok === false ? checked.message : undefined),
        label: `${target.kind === 'in' ? '移入' : '移到上一级'}：${name}` };
      setDropPreview(session.preview);
    }
    const { x, y } = dragDelta(session, node.position);
    setDrag(new Map(session.members.map(item => [item.key, { x: item.position.x + x, y: item.position.y + y }])));
  }

  function cancelDrag() {
    dragSession.current = undefined;
    setDrag(undefined);
    setDropPreview(undefined);
  }

  function finishDrag(event: MouseEvent | TouchEvent, node: CanvasNode) {
    const session = dragSession.current;
    const preview = renderedPreview.current;
    cancelDrag();
    if (!session) return;
    const point = pointerOnCanvas(event);
    if (!point) {
      report('请在框图的有效区域松手。');
      return;
    }
    const target = targetAt(session, point);
    if (target) {
      if (!preview || preview !== session.preview || preview.kind !== target.kind || hierarchyKey(preview.destination) !== hierarchyKey(target.destination)) {
        report(target.problem ?? '请等目标显示移动预览后再松手。');
        return;
      }
      if (!preview.plan || target.problem) {
        report(target.problem ?? preview.error ?? '无法移动到该模块。');
        return;
      }
      const frame = target.node?.frame;
      const bounds = target.node && boundsOf(target.node);
      const definition = target.node?.item.definition;
      const position = frame && bounds ? {
        x: point.x - bounds.x + frame.display.x - session.anchor.bounds.width / 2,
        y: point.y - bounds.y + frame.display.y - session.anchor.bounds.height / 2,
      } : target.kind === 'up' ? {
        x: point.x - session.anchor.bounds.width / 2, y: point.y - session.anchor.bounds.height / 2,
      } : definition?.kind === 'module' ? defaultTopologyPosition(definition.instances.length, definition.ports.length) : undefined;
      const plan = preview.plan;
      const saved = session.base.layout?.topologyFrames?.find(frame => hierarchyKey(frame.modulePath) === hierarchyKey(target.destination));
      const dropped = position && placeDropGroup(session.bounds, session.anchor.bounds, position, saved,
        frame?.insets ?? (definition && frameInsets(definition.ports)));
      const layout = dropped && {
        placements: session.members.map((item, index) => ({
          instancePath: plan.instancePaths[index], x: item.bounds.x + dropped.delta.x, y: item.bounds.y + dropped.delta.y,
        })),
        frame: dropped.frame,
      };
      reparent(session.base, plan, layout);
      return;
    }
    const { x, y } = dragDelta(session, node.position);
    if (x || y) move(session.members.map(item => ({
      instancePath: item.item.instancePath, x: item.bounds.x + x, y: item.bounds.y + y,
    })), session.frame);
  }

  function readBoxSelection() {
    const { userSelectionRect: rect, userSelectionActive, nodeLookup, transform: [x, y, zoom] } = flowStore.getState();
    if (!userSelectionActive || !rect) return;
    const left = (rect.x - x) / zoom;
    const top = (rect.y - y) / zoom;
    const right = left + rect.width / zoom;
    const bottom = top + rect.height / zoom;
    boxSelection.current = [...nodeLookup.values()].flatMap(node => {
      const { positionAbsolute: p } = node.internals;
      const { width, height } = node.measured;
      return node.selectable !== false && width && height
        && p.x >= left && p.y >= top && p.x + width <= right && p.y + height <= bottom ? [node.data.path] : [];
    });
  }

  function cancelBoxSelection() {
    boxSelection.current = undefined;
    flowStore.setState({ userSelectionActive: false, userSelectionRect: null, nodesSelectionActive: false });
  }

  function placeAt(item: LibraryItem, screen: XYPosition) {
    if (!flow.current) return;
    cancelWiring();
    setSelectedEdgeKey(undefined);
    add(item, flow.current.screenToFlowPosition(screen));
  }

  useImperativeHandle(centerPlacement, () => (definition, name) => {
    if (!topologyActive) return;
    const position = viewportPosition(definition.ports, name);
    return position && { position, projection };
  });

  function viewportPosition(ports: readonly PortDefinition[], name?: string) {
    const inserting = name !== undefined;
    if (!canvas.current || !flow.current) return;
    const screen = canvas.current.getBoundingClientRect();
    const left = inserting ? Math.max(0, screen.left) : screen.left;
    const top = inserting ? Math.max(0, screen.top) : screen.top;
    const right = inserting ? Math.min(window.innerWidth, screen.right) : screen.right;
    const bottom = inserting ? Math.min(window.innerHeight, screen.bottom) : screen.bottom;
    if (right <= left || bottom <= top) return;
    const topLeft = flow.current.screenToFlowPosition({ x: left, y: top });
    const bottomRight = flow.current.screenToFlowPosition({ x: right, y: bottom });
    const scope = nodeByKey.get(rootKey);
    const extent = !inserting && scope?.frame?.saved ? moduleExtent(scope.frame.base, scope.frame.insets) : undefined;
    const visible: CoordinateExtent = extent ? [
      [Math.max(topLeft.x, extent[0][0]), Math.max(topLeft.y, extent[0][1])],
      [Math.min(bottomRight.x, extent[1][0]), Math.min(bottomRight.y, extent[1][1])],
    ] : [[topLeft.x, topLeft.y], [bottomRight.x, bottomRight.y]];
    const size = estimatedBlockSize(ports);
    const width = inserting ? parseFloat(getComputedStyle(canvas.current).getPropertyValue('--v1-block-width-rem'))
      * parseFloat(getComputedStyle(document.documentElement).fontSize) : size.width;
    const members = scopes.get(rootKey)?.members ?? [];
    // A rendered copy accounts for wrapping in the selected card's title and controls.
    const height = inserting ? members.reduce((height, node) =>
      !node.frame && node.item.instance?.name === name && node.item.definition.ports.length === ports.length
        ? Math.max(height, node.bounds.height) : height, size.height) : size.height;
    const center = { x: (topLeft.x + bottomRight.x - width) / 2, y: (topLeft.y + bottomRight.y - height) / 2 };
    const occupied = members.map(item => ({
      ...item.bounds, width: item.frame?.display.width ?? item.bounds.width, height: item.frame?.display.height ?? item.bounds.height,
    }));
    const fits = visible[1][0] - visible[0][0] >= width && visible[1][1] - visible[0][1] >= height;
    // Keep the viewport fixed. Prefer a nearby visible gap and use the least-overlapping candidate in a crowded view.
    const offsets = [[0, 0], [0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]];
    function candidateAt(x: number, y: number) {
      const rect = { x, y, width, height };
      const limit = fits ? visible : extent;
      const position = limit ? keepNodeInside(rect, limit) : { x: rect.x, y: rect.y };
      if (inserting && !fits) {
        position.x = Math.max(topLeft.x - width / 2, Math.min(position.x, bottomRight.x - width / 2));
        position.y = Math.max(topLeft.y - height / 2, Math.min(position.y, bottomRight.y - height / 2));
      }
      let overlap = 0;
      let largest = 0;
      for (const node of occupied) {
        const area = Math.max(0, Math.min(node.x + node.width, position.x + width) - Math.max(node.x, position.x))
          * Math.max(0, Math.min(node.y + node.height, position.y + height) - Math.max(node.y, position.y));
        overlap += area;
        largest = Math.max(largest, area);
      }
      return { position, overlap, largest, distance: Math.hypot(position.x - center.x, position.y - center.y) };
    }
    const candidates = offsets.map(([x, y]) => candidateAt(center.x + x * (width + 16), center.y + y * (height + 16)));
    let best = candidates.reduce((best, candidate) => candidate.overlap < best.overlap ? candidate : best);
    if (!inserting || !best.overlap) return best.position;

    // Try the free edges of visible cards. In a full view, a half-card stagger keeps titles distinguishable.
    for (const node of occupied) {
      if (node.x + node.width < topLeft.x || node.x > bottomRight.x || node.y + node.height < topLeft.y || node.y > bottomRight.y) continue;
      const neighbors = [[node.x, node.y - height - 16], [node.x, node.y + node.height + 16],
        [node.x - width - 16, node.y], [node.x + node.width + 16, node.y],
        [node.x - width / 2, node.y - height / 2], [node.x + width / 2, node.y + height / 2]];
      for (const [x, y] of neighbors) {
        const option = candidateAt(x, y);
        if (option.largest < best.largest || (option.largest === best.largest &&
          (option.overlap < best.overlap || (option.overlap === best.overlap && option.distance < best.distance)))) best = option;
      }
    }
    return best.position;
  }

  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (event.defaultPrevented || canvas.current?.closest('[inert]') || document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape' && placingModule) {
        event.preventDefault();
        cancelWiring();
        cancelPlacement();
        return;
      }
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) return;
      if (event.key === 'Escape' && wireStart) {
        event.preventDefault();
        cancelWiring();
        report('');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelBoxSelection();
        const dragging = !!dragSession.current;
        cancelDrag();
        setSelectedEdgeKey(undefined);
        if (!dragging) selectObjects([]);
        report('');
      } else if (event.key === 'Enter' && event.target instanceof HTMLElement && event.target.matches('.react-flow__node')) {
        const node = flow.current?.getNode(event.target.dataset.id ?? '');
        if (node && node.selectable !== false) selectObject(node.data.path, event.ctrlKey || event.shiftKey || event.metaKey);
      } else if (event.key === 'F2' && selectedNode && selectedNode.key !== rootKey) {
        event.preventDefault();
        rename();
      } else if (event.key === 'Delete') {
        const targets = selectedPaths.filter(path => hierarchyKey(path) !== rootKey);
        if (targets.length && targets.every(path => nodeByKey.has(hierarchyKey(path)))) {
          event.preventDefault();
          deleteInstances(targets, (next, parentIds) => preserveDeletionLayout(next, parentIds, projection, modulePath, expanded, measured));
        } else if (selectedWiring && selectedWiring.data) {
          event.preventDefault();
          if (deleteWiring(selectedWiring.data.scope, selectedWiring.data.wire)) setSelectedEdgeKey(undefined);
        }
      } else if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        if (!event.altKey && !event.shiftKey && key === 'c' && !event.repeat
          && (window.getSelection()?.isCollapsed ?? true) && copyModule()) {
          event.preventDefault();
        } else if (!event.altKey && !event.shiftKey && key === 'v' && !event.repeat && pasteModule(viewportPosition)) {
          event.preventDefault();
        } else if (key === 'z' || key === 'y') {
          event.preventDefault();
          if (event.shiftKey || key === 'y') redo();
          else undo();
        }
      }
    }
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  });

  const renderedEdges = edges.map(edge => {
    const data = edge.data!;
    const key = hierarchyKey(data.scope);
    const frame = nodeByKey.get(key)?.frame;
    const origin = frameOrigins.get(nodeId(key));
    const dx = origin && frame ? origin.x - frame.display.x : 0;
    const dy = origin && frame ? origin.y - frame.display.y : 0;
    const saved = routes.get(edge.id);
    const selected = selectedWiring === edge;
    const ref = wireEndpoints(edge)[0];
    const reading = ref && multiplexCaption(multiplex.at(ref));
    return { ...edge, selected, data: { ...data,
      caption: reading && ref ? multiplex.label(ref) + ' · ' + reading : data.caption,
      routePoint: saved && { x: saved.x + dx, y: saved.y + dy },
      savePoint: selected ? (p?: XYPosition) => route(data.scope, data.wire, p && { x: p.x - dx, y: p.y - dy }) : undefined,
    } };
  });

  function switchFullPage() {
    if (flow.current) toggleFullPage({ viewport: flow.current.getViewport(), edgeId: selectedWiring ? selectedWiring.id : undefined });
  }

  return <div ref={canvas} className="v1-topology-canvas" aria-label="逻辑拓扑画布" tabIndex={-1}
    data-space-pan={panWithSpace}
    onPointerDownCapture={event => { if (panWithSpace) event.currentTarget.focus({ preventScroll: true }); }}
    onPointerUpCapture={event => { if (event.button === 0) readBoxSelection(); }}
    onPointerCancel={() => { cancelBoxSelection(); cancelDrag(); }}
    onDragOver={event => {
      if (!event.dataTransfer.types.includes(libraryDragType)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }}
    onDrop={event => {
      if (!event.dataTransfer.types.includes(libraryDragType)) return;
      event.preventDefault();
      const item = readLibraryItem(event.dataTransfer);
      if (item) placeAt(item, { x: event.clientX, y: event.clientY });
    }}>
    <ReactFlow<CanvasNode, WiringEdge> nodes={nodes} edges={renderedEdges}
      nodeTypes={nodeTypes} edgeTypes={edgeTypes} ariaLabelConfig={flowAriaLabels} fitView={fitInitialNodes} defaultViewport={initialViewport} fitViewOptions={canvasFitOptions}
      viewport={viewport} onViewportChange={changeViewport} onInit={instance => { flow.current = instance; }}
      minZoom={0.001} maxZoom={2} deleteKeyCode={null} connectionMode={ConnectionMode.Loose}
      zIndexMode="manual" selectNodesOnDrag={false}
      selectionKeyCode={null} multiSelectionKeyCode={null} selectionOnDrag={!panWithSpace}
      panActivationKeyCode={null} panOnDrag={panWithSpace ? true : [1, 2]} zoomOnDoubleClick={false}
      onSelectionStart={() => {
        cancelWiring();
        setSelectedEdgeKey(undefined);
        boxSelection.current = undefined;
      }}
      onSelectionEnd={() => {
        const paths = boxSelection.current;
        boxSelection.current = undefined;
        if (paths) selectObjects(paths);
        queueMicrotask(() => flowStore.setState({ nodesSelectionActive: false }));
      }}
      connectionLineStyle={{ opacity: cancelled.current ? 0 : undefined,
        stroke: fromPort && signalColor(fromPort.port.type), strokeWidth: 'var(--v1-wire-width)' }}
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
      onPaneClick={event => {
        if (panWithSpace) return;
        cancelWiring();
        setSelectedEdgeKey(undefined);
        const point = pointerOnCanvas(event.nativeEvent);
        // Frame backgrounds leave pointer events to the pane so box selection still works.
        const frame = point && expandedFrameAt(point);
        if (frame) selectObject(frame.item.instancePath, event.ctrlKey || event.shiftKey || event.metaKey);
        else selectObjects([]);
        report('');
      }}
      onEdgeClick={(event, edge) => {
        cancelWiring();
        report('');
        // A wire's wider click area can overlap the title of a frame below it.
        const title = document.elementsFromPoint(event.clientX, event.clientY)
          .find(element => element.closest('.v1-frame-title'));
        const id = title?.closest('.react-flow__node')?.getAttribute('data-id');
        const frame = id ? flow.current?.getNode(id) : undefined;
        if (frame?.type === 'moduleFrame') {
          setSelectedEdgeKey(undefined);
          selectObject(frame.data.path, event.ctrlKey || event.shiftKey || event.metaKey);
        } else {
          selectObjects([]);
          setSelectedEdgeKey(edge.id);
        }
      }}
      onNodeClick={(event, node) => {
        if (event.target instanceof Element && event.target.closest('.react-flow__handle')) return;
        cancelWiring();
        setSelectedEdgeKey(undefined);
        selectObject(node.data.path, event.ctrlKey || event.shiftKey || event.metaKey);
        report('');
      }}
      onNodeDoubleClick={(event, node) => {
        if (event.target instanceof Element && event.target.closest('.react-flow__handle')) return;
        if (node.data.toggle) enterModule(node.data.path);
      }}
      onNodesChange={changes => {
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
      onNodeDragStart={(_, node, moving) => startDrag(node, moving)}
      onNodeDrag={previewDrag}
      onNodeDragStop={finishDrag}>
      <Background />
      <ViewportPortal><div className="v1-frame-surfaces" aria-hidden="true">{frameSurfaces}</div></ViewportPortal>
      {placingModule && !panWithSpace && <ModulePlacement
        zoom={() => flow.current?.getZoom()}
        place={screen => placeAt({ source: 'blank-module', id: blankModuleId, name: '新建模块', automaticName: true }, screen)} />}
      <CanvasControls depth={depth} fullPage={fullPage} canLocate={!!locateIds.length} locate={() => {
        if (locateIds.length) void flow.current?.fitView({ ...canvasFitOptions, nodes: locateIds.map(id => ({ id })), maxZoom: 1.2 });
      }} toggleFullPage={switchFullPage} />
    </ReactFlow>
    {selectedWiring && <aside className="v1-wire-readings"><MultiplexDetails power={multiplex}
      endpoints={wireEndpoints(selectedWiring)} title="复用光 · 查看两端逐波功率" /></aside>}
    {topologyActive && viewHost && !fullPage && createPortal(<button type="button" onClick={switchFullPage}>全页展示</button>, viewHost)}
    {dropPreview && <>
      {!dropPreview.node && <div className="v1-drop-canvas" aria-hidden="true" />}
      <p className="v1-drop-label" role="status" data-blocked={!!dropPreview.error}>
        {dropPreview.error ?? dropPreview.label}
        {dropPreview.selectedCount > 1 && ` · ${dropPreview.selectedCount} 个选中对象`}
        {dropPreview.plan && ` · ${moveWiringSummary(dropPreview.plan.wiring)}`}
        {dropPreview.plan && dropPreview.plan.affected.length > dropPreview.plan.instancePaths.length
          && ` · 影响 ${dropPreview.plan.affected.length} 处实例`}
      </p>
    </>}
    {!scopes.get(rootKey)?.members.length && <span className="v1-topology-empty">从器件库添加器件，或声明对外端口。</span>}
  </div>;
}
