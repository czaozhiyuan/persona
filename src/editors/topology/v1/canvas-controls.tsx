import { Panel, useReactFlow, useViewport, type AriaLabelConfig } from '@xyflow/react';
import type { FitViewOptions, Viewport } from '@xyflow/react';

export const canvasFitOptions: FitViewOptions = {
  padding: { left: '30px', right: '30px', top: '56px', bottom: '50px' },
};

export const flowAriaLabels = {
  'node.a11yDescription.default': '按回车键或空格键选择节点，按 Esc 键取消选择。',
  'node.a11yDescription.keyboardDisabled': '按回车键或空格键选择节点，可用方向键移动已选节点。按 Esc 键取消选择。',
  'node.a11yDescription.ariaLiveMessage': ({ x, y }) => `节点已移动到 X ${x}，Y ${y}。`,
  'edge.a11yDescription.default': '按回车键或空格键选择连线，按 Esc 键取消选择。',
  'handle.ariaLabel': '端口',
} satisfies Partial<AriaLabelConfig>;

export type CanvasView = { viewport: Viewport; edgeId?: string };
export type ExpansionDepth = { value: number; max: number; set: (depth: number) => void };

export function CanvasControls({ locate, canLocate, depth, fullPage, toggleFullPage }: {
  locate: () => void; canLocate: boolean; depth: ExpansionDepth; fullPage: boolean; toggleFullPage: () => void;
}) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  return <Panel position="bottom-right" className="v1-canvas-zoom nopan nowheel" aria-label="框图视图控件">
    <DepthControl depth={depth} />
    <div className="v1-canvas-control-group">
      <button type="button" aria-label="缩小" title="缩小" onClick={() => void zoomOut()}>−</button>
      <output aria-label="缩放比例">{Math.round(zoom * 100)}%</output>
      <button type="button" aria-label="放大" title="放大" onClick={() => void zoomIn()}>+</button>
      <button type="button" aria-label="定位选中" title="定位选中" disabled={!canLocate} onClick={locate}>◎</button>
      <button type="button" aria-label="适应画布" title="适应画布" onClick={() => void fitView(canvasFitOptions)}>⛶</button>
      {fullPage && <button type="button" className="v1-full-page-toggle" onClick={toggleFullPage}>退出全页展示</button>}
    </div>
  </Panel>;
}

function DepthControl({ depth }: { depth: ExpansionDepth }) {
  return <div className="v1-canvas-control-group v1-hierarchy-depth">
    <button type="button" disabled={depth.max === 1} onClick={() => depth.set(1)}>收起</button>
    <input type="range" min={1} max={depth.max} value={depth.value} disabled={depth.max === 1}
      aria-label="模块展开深度" onChange={event => depth.set(Number(event.currentTarget.value))} />
    <button type="button" disabled={depth.max === 1} onClick={() => depth.set(depth.max)}>展开</button>
    <output aria-label="当前展开深度">{depth.value} / {depth.max}</output>
  </div>;
}
