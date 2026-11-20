import { useReactFlow } from '@xyflow/react';
import type { Rect } from '@xyflow/react';
import { useRef } from 'react';
import type { PointerEvent } from 'react';
import { dragFrame } from './frame-geometry';
import type { ResizeDirection } from './frame-geometry';
import type { frameInsets } from './module-frame';

const sides = {
  n: '上边', s: '下边', w: '左边', e: '右边',
  nw: '左上角', ne: '右上角', sw: '左下角', se: '右下角',
} satisfies Record<ResizeDirection, string>;

export function FrameResizeHandles({ frame, childrenBounds, insets, preview, finish }: {
  frame: Rect;
  childrenBounds: readonly Rect[];
  insets: ReturnType<typeof frameInsets>;
  preview: (frame?: Rect) => void;
  finish: (frame: Rect) => void;
}) {
  const { getZoom } = useReactFlow();
  const gesture = useRef<{
    pointerId: number;
    rectangle: (event: PointerEvent<HTMLDivElement>) => Rect;
    original: Rect;
  } | undefined>(undefined);
  function start(event: PointerEvent<HTMLDivElement>, direction: ResizeDirection) {
    if (event.button !== 0 || gesture.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const { clientX, clientY } = event;
    const zoom = getZoom();
    gesture.current = {
      pointerId: event.pointerId, original: frame,
      rectangle: next => dragFrame(frame, direction, {
        x: (next.clientX - clientX) / zoom,
        y: (next.clientY - clientY) / zoom,
      }, childrenBounds, insets),
    };
  }
  function cancel(event: PointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = undefined;
    preview();
  }
  return (Object.keys(sides) as ResizeDirection[]).map(direction => <div key={direction}
    className={`v1-frame-resize v1-frame-resize-${direction} nodrag nopan`}
    title={`拖动${sides[direction]}调整模块边框`} data-resize-direction={direction}
    onPointerDown={event => start(event, direction)}
    onPointerMove={event => {
      const active = gesture.current;
      if (active?.pointerId === event.pointerId) preview(active.rectangle(event));
    }}
    onPointerUp={event => {
      const active = gesture.current;
      if (active?.pointerId !== event.pointerId) return;
      cancel(event);
      const next = active.rectangle(event);
      const before = active.original;
      if (next.x !== before.x || next.y !== before.y || next.width !== before.width || next.height !== before.height) finish(next);
    }}
    onPointerCancel={cancel} onLostPointerCapture={cancel}
    onClick={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()} />);
}
