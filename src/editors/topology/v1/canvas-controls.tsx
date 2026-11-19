import { Panel, useReactFlow, useViewport, type AriaLabelConfig } from '@xyflow/react';
import type { FitViewOptions } from '@xyflow/react';

export function canvasFitOptions(treeHidden: boolean): FitViewOptions {
  return { padding: { left: treeHidden ? '44px' : '232px', right: '88px', top: '62px', bottom: '54px' } };
}

export const flowAriaLabels = {
  'node.a11yDescription.default': '按回车键或空格键选择节点，按 Esc 键取消选择。',
  'node.a11yDescription.keyboardDisabled': '按回车键或空格键选择节点，可用方向键移动已选节点。按 Esc 键取消选择。',
  'node.a11yDescription.ariaLiveMessage': ({ x, y }) => `节点已移动到 X ${x}，Y ${y}。`,
  'edge.a11yDescription.default': '按回车键或空格键选择连线，按 Esc 键取消选择。',
  'handle.ariaLabel': '端口',
} satisfies Partial<AriaLabelConfig>;

export function CanvasControls({ treeHidden }: { treeHidden: boolean }) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  return <Panel position="bottom-right" className="v1-canvas-zoom" aria-label="画布缩放">
    <button type="button" aria-label="缩小" title="缩小" onClick={() => void zoomOut()}>−</button>
    <output aria-label="缩放比例">{Math.round(zoom * 100)}%</output>
    <button type="button" aria-label="放大" title="放大" onClick={() => void zoomIn()}>+</button>
    <button type="button" aria-label="适应画布" title="适应画布" onClick={() => void fitView(canvasFitOptions(treeHidden))}>⛶</button>
  </Panel>;
}
