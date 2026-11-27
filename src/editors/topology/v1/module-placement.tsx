import { useEffect, useRef, useState } from 'react';
import type { XYPosition } from '@xyflow/react';

const clickSlop = 5;

export function ModulePlacement({ previewAt, place }: {
  previewAt: (screen: XYPosition, free: boolean) => (XYPosition & { zoom: number }) | undefined;
  place: (screen: XYPosition, free: boolean) => void;
}) {
  const [preview, setPreview] = useState<(XYPosition & { zoom: number }) | undefined>();
  const overlay = useRef<HTMLDivElement>(null);
  const pointer = useRef<XYPosition | undefined>(undefined);
  const press = useRef<XYPosition | undefined>(undefined);
  const isClick = (x: number, y: number) => press.current && Math.hypot(x - press.current.x, y - press.current.y) <= clickSlop;
  function leave() {
    press.current = undefined;
    pointer.current = undefined;
    setPreview(undefined);
  }

  function updatePreview(free: boolean) {
    const point = pointer.current && previewAt(pointer.current, free);
    const rect = overlay.current?.getBoundingClientRect();
    setPreview(point && rect && { zoom: point.zoom, x: point.x - rect.left, y: point.y - rect.top });
  }
  useEffect(() => {
    function modifier(event: KeyboardEvent) {
      if (event.key === 'Alt' && pointer.current) { event.preventDefault(); updatePreview(event.type === 'keydown'); }
    }
    window.addEventListener('keydown', modifier);
    window.addEventListener('keyup', modifier);
    return () => { window.removeEventListener('keydown', modifier); window.removeEventListener('keyup', modifier); };
  });

  return <div ref={overlay} className="v1-module-placement" aria-hidden="true"
    onPointerMove={event => {
      const { clientX: x, clientY: y } = event;
      if (!isClick(x, y)) press.current = undefined;
      pointer.current = { x, y };
      updatePreview(event.altKey);
    }}
    onPointerDown={event => {
      if (event.isPrimary && event.button === 0) press.current = { x: event.clientX, y: event.clientY };
    }}
    onPointerUp={event => {
      if (!event.isPrimary || event.button !== 0) return;
      const { clientX: x, clientY: y } = event;
      const clicked = isClick(x, y);
      press.current = undefined;
      if (clicked) place({ x, y }, event.altKey);
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
