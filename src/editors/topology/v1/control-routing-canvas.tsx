import { Background, BaseEdge, ConnectionMode, getSmoothStepPath, Handle, Panel, Position, ReactFlow,
  ReactFlowProvider, useReactFlow, useStoreApi, useViewport } from '@xyflow/react';
import type { Edge, EdgeProps, Node, NodeProps, OnConnectStartParams } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import type { PathResult } from '../../../engine/v1/path-resolver';
import type { Transfer } from '../../../model/v1/device';
import type { ComponentDefinition, InstancePath } from '../../../model/v1/types';
import type { ProjectStore } from '../../../state/v1/project-store';
import { portDisplayName } from '../../../workbench/v1/labels';
import { canvasFitOptions, flowAriaLabels } from './canvas-controls';
import { hierarchyKey } from './hierarchy-view';
import './control-routing.css';

type PortNode = Node<{ label: string; input: boolean; heading: boolean; wire?: 'origin' | 'target' }, 'port'>;
type Route = Extract<Transfer, { kind: 'control' }>;
type RouteEdge = Edge<{ lane?: number }, 'route'>;
type Props = {
  store: ProjectStore; definition: ComponentDefinition; path: InstancePath; result?: PathResult;
  shared: readonly string[]; showName: (path: InstancePath) => string;
  back: () => void; enterModule: (path: InstancePath) => void; openPorts: () => void;
};

const routeId = (input: string, output: string) => encodeURIComponent(JSON.stringify([input, output]));
const columnX = 500;
const portWidth = 190;

function Port({ data }: NodeProps<PortNode>) {
  return <div className="v1-routing-port" data-direction={data.input ? 'in' : 'out'}>
    {data.heading && <strong>{data.input ? '输入端口' : '输出端口'}</strong>}
    <span title={data.label}>{data.label}</span>
    <Handle type={data.input ? 'source' : 'target'} position={data.input ? Position.Right : Position.Left}
      data-wire={data.wire} aria-label={data.label} />
  </div>;
}

function Wire(edge: EdgeProps<RouteEdge>) {
  const [path] = getSmoothStepPath({ ...edge, centerX: edge.data?.lane, borderRadius: 8 });
  return <g className="v1-signal-wire">
    <path d={path} className="v1-wire-halo" /><path d={path} className="v1-wire-casing" />
    <BaseEdge id={edge.id} path={path} interactionWidth={12} className="v1-wire-main"
      style={{ stroke: 'var(--v1-signal-CONTROL)' }} />
  </g>;
}
const nodeTypes = { port: Port };
const edgeTypes = { route: Wire };

export function ControlRoutingCanvas(props: Props) {
  return <ReactFlowProvider><Editor {...props} /></ReactFlowProvider>;
}

function Editor({ store, definition, path, result, shared, showName, back, enterModule, openPorts }: Props) {
  const flowStore = useStoreApi();
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  const canvas = useRef<HTMLElement>(null);
  const cancelled = useRef(false);
  const [origin, setOrigin] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [lanes, setLanes] = useState(new Map<string, number>());
  const [error, setError] = useState('');
  const ports = definition.ports.filter(port => port.type === 'CONTROL');
  const inputs = ports.filter(port => port.direction === 'in');
  const outputs = ports.filter(port => port.direction === 'out');
  const routes = definition.transfers?.filter((item): item is Route => item.kind === 'control') ?? [];
  const routeIds = new Set(routes.map(item => routeId(item.fromPortId, item.toPortId)));
  const pathKey = hierarchyKey(path);
  const pathEdges = [...(result?.trace?.edges ?? []), ...(result && result.status !== 'resolved' ? result.digitalAccess ?? [] : [])];
  const highlighted = new Set(pathEdges.flatMap(edge => {
    if (edge.source.kind !== 'transfer' || edge.source.transfer.kind !== 'control' || hierarchyKey(edge.from.ref.instancePath) !== pathKey) return [];
    return [routeId(edge.from.ref.portId, edge.to.ref.portId)];
  }));
  const portByNode = new Map(ports.map(port => [encodeURIComponent(port.id), port]));
  function candidate(start: string, end: string) {
    const a = portByNode.get(start), b = portByNode.get(end);
    if (!a || !b || a.direction === b.direction) return;
    const [input, output] = a.direction === 'in' ? [a, b] : [b, a];
    if (!routeIds.has(routeId(input.id, output.id))) return { kind: 'control', fromPortId: input.id, toPortId: output.id } as const;
  }
  function change(edit: (current: readonly Transfer[]) => readonly Transfer[]) {
    const result = store.commit(draft => ({ ...draft, componentDefinitions: draft.componentDefinitions.map(item =>
      item.id === definition.id ? { ...item, transfers: edit(item.transfers ?? []) } : item) }));
    setError(result.ok ? '' : result.message);
  }
  function cancel() {
    cancelled.current = true;
    flowStore.getState().cancelConnection();
    flowStore.setState({ connectionClickStartHandle: null });
    setOrigin(undefined);
  }
  function start(_event: MouseEvent | TouchEvent, { nodeId }: OnConnectStartParams) {
    cancelled.current = false;
    setOrigin(nodeId ?? undefined);
    setSelected(undefined);
  }
  function organize() {
    const inputOrder = new Map(inputs.map((port, i) => [port.id, i]));
    const outputOrder = new Map(outputs.map((port, i) => [port.id, i]));
    const ordered = routes.slice().sort((a, b) => inputOrder.get(a.fromPortId)! - inputOrder.get(b.fromPortId)!
      || outputOrder.get(a.toPortId)! - outputOrder.get(b.toPortId)!);
    setLanes(new Map(ordered.map((item, i) =>
      [routeId(item.fromPortId, item.toPortId), portWidth + 24 + (columnX - portWidth - 48) * (i + 1) / (ordered.length + 1)])));
  }
  useEffect(() => { canvas.current?.focus(); }, []);
  const nodes: PortNode[] = [inputs, outputs].flatMap((column, side) => column.map((port, row) => {
    const id = encodeURIComponent(port.id);
    const position = side === 0 ? Position.Right : Position.Left;
    return { id, type: 'port', width: portWidth, height: 30, measured: { width: portWidth, height: 30 },
      sourcePosition: position, targetPosition: position, position: { x: side * columnX, y: row * 48 },
      data: { input: side === 0, heading: row === 0, label: portDisplayName(port, false, definition.ports),
        wire: origin === id ? 'origin' : origin && candidate(origin, id) ? 'target' : undefined } };
  }));
  const edges: RouteEdge[] = routes.map(item => {
    const id = routeId(item.fromPortId, item.toPortId);
    return { id, type: 'route', source: encodeURIComponent(item.fromPortId), target: encodeURIComponent(item.toPortId),
      className: highlighted.has(id) ? 'v1-path-edge' : undefined, selected: id === selected, data: { lane: lanes.get(id) } };
  });
  return <section ref={canvas} tabIndex={-1} className="v1-routing v1-topology-canvas" aria-label="内部信号连线"
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      const key = event.key.toLowerCase();
      if (key === 'escape') { cancel(); setSelected(undefined); }
      else if ((event.ctrlKey || event.metaKey) && (key === 'z' || key === 'y')) {
        cancel();
        if (key === 'y' || event.shiftKey) store.redo(); else store.undo();
      } else if (key === 'delete' && selected && routeIds.has(selected)) {
        change(current => current.filter(item => item.kind !== 'control' || routeId(item.fromPortId, item.toPortId) !== selected));
        setSelected(undefined);
      } else return;
      event.preventDefault();
    }}>
    <ReactFlow<PortNode, RouteEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      ariaLabelConfig={flowAriaLabels} fitView fitViewOptions={canvasFitOptions} minZoom={0.001} maxZoom={2}
      nodesDraggable={false} nodesFocusable={false} deleteKeyCode={null} zoomOnDoubleClick={false}
      connectionMode={ConnectionMode.Loose} connectionLineStyle={{ stroke: 'var(--v1-signal-CONTROL)', opacity: cancelled.current ? 0 : 1 }}
      onConnectStart={start} onClickConnectStart={start} onConnectEnd={() => setOrigin(undefined)} onClickConnectEnd={() => setOrigin(undefined)}
      isValidConnection={edge => !cancelled.current && !!candidate(edge.source, edge.target)}
      onConnect={edge => {
        const route = candidate(edge.source, edge.target);
        if (route && !cancelled.current) change(current => [...current, route]);
      }}
      onEdgeClick={(_, edge) => { cancel(); setSelected(edge.id); canvas.current?.focus(); }}
      onPaneClick={() => { cancel(); setSelected(undefined); canvas.current?.focus(); }}>
      <Background />
      <Panel position="bottom-right" className="v1-canvas-zoom nopan nowheel" aria-label="内部画布视图控件">
        <div className="v1-canvas-control-group v1-organize-controls">
          <button type="button" onClick={organize} disabled={!routes.length}>理线</button>
        </div>
        <div className="v1-canvas-control-group">
          <button type="button" aria-label="缩小" onClick={() => void zoomOut()}>−</button>
          <output aria-label="缩放比例">{Math.round(zoom * 100)}%</output>
          <button type="button" aria-label="放大" onClick={() => void zoomIn()}>+</button>
          <button type="button" aria-label="适应画布" onClick={() => void fitView(canvasFitOptions)}>⛶</button>
        </div>
      </Panel>
    </ReactFlow>
    <div className="v1-canvas-heading">
      <nav className="v1-topology-path" aria-label="内部连线路径">
        {path.map((_, i) => <span key={i}><button type="button" onClick={() => enterModule(path.slice(0, i))}>{showName(path.slice(0, i))}</button>›</span>)}
        <strong aria-current="location">{showName(path)}</strong>
      </nav>
      <div className="v1-routing-actions"><strong>内部信号连线</strong>
        <button type="button" onClick={openPorts}>端口管理</button><button type="button" onClick={back}>返回框图</button>
      </div>
      {shared.length > 0 && <p className="v1-routing-note">共享定义 · 影响 {shared.join('、')}</p>}
      {(!inputs.length || !outputs.length) && <p className="v1-routing-note">{!inputs.length && '尚无控制输入端口。'}{!outputs.length && '尚无控制输出端口。'}</p>}
    </div>
    {error && <p className="v1-topology-message error" role="alert">{error}</p>}
  </section>;
}
