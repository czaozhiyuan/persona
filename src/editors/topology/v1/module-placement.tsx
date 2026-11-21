import { useRef, useState } from 'react';
import type { XYPosition } from '@xyflow/react';

const clickSlop = 5;

export function ModulePlacement({ zoom, place }: {
  zoom: () => number | undefined;
  place: (screen: XYPosition) => void;
}) {
  const [preview, setPreview] = useState<(XYPosition & { zoom: number }) | undefined>();
  const press = useRef<XYPosition | undefined>(undefined);
  const isClick = (x: number, y: number) => press.current && Math.hypot(x - press.current.x, y - press.current.y) <= clickSlop;
  function leave() {
    press.current = undefined;
    setPreview(undefined);
  }

  return <div className="v1-module-placement" aria-hidden="true"
    onPointerMove={event => {
      const { clientX: x, clientY: y } = event;
      if (!isClick(x, y)) press.current = undefined;
      const scale = zoom();
      const rect = event.currentTarget.getBoundingClientRect();
      setPreview(scale === undefined ? undefined : { zoom: scale, x: x - rect.left, y: y - rect.top });
    }}
    onPointerDown={event => {
      if (event.isPrimary && event.button === 0) press.current = { x: event.clientX, y: event.clientY };
    }}
    onPointerUp={event => {
      if (!event.isPrimary || event.button !== 0) return;
      const { clientX: x, clientY: y } = event;
      const clicked = isClick(x, y);
      press.current = undefined;
      if (clicked) place({ x, y });
    }}
    onPointerLeave={leave} onPointerCancel={leave}>
    {preview && <div className="v1-module-placement-preview v1-topology-device"
      style={{ left: preview.x, top: preview.y, transform: `scale(${preview.zoom})` }}>
      <strong>新建模块</strong>
    </div>}
    {preview && <span className="v1-module-placement-label" style={{ left: preview.x, top: preview.y }}>
      单击放置
    </span>}
  </div>;
}
