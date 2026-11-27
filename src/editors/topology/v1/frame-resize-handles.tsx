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

export function FrameResizeHandles({ frame, childrenBounds, insets, originLimit, gridOffset, preview, finish }: {
  frame: Rect;
  childrenBounds: readonly Rect[];
  insets: ReturnType<typeof frameInsets>;
  gridOffset: Pick<Rect, 'x' | 'y'>;
  originLimit?: Pick<Rect, 'x' | 'y'>;
  preview: (frame?: Rect) => void;
  finish: (frame: Rect, original: Rect) => void;
}) {
  const { getZoom } = useReactFlow();
  const gesture = useRef<{
    pointerId: number;
    last: { clientX: number; clientY: number };
    rectangle: (next: { clientX: number; clientY: number }, free: boolean) => Rect;
    original: Rect;
  } | undefined>(undefined);
  function start(event: PointerEvent<HTMLDivElement>, direction: ResizeDirection) {
    if (event.button !== 0 || gesture.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const { clientX, clientY } = event;
    const zoom = getZoom();
    gesture.current = {
      pointerId: event.pointerId, original: frame, last: { clientX, clientY },
      rectangle: (next, free) => dragFrame(frame, direction, {
        x: (next.clientX - clientX) / zoom,
        y: (next.clientY - clientY) / zoom,
      }, childrenBounds, insets, originLimit, gridOffset, free),
    };
  }
  function cancel(event: PointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = undefined;
    preview();
  }
  return (Object.keys(sides) as ResizeDirection[]).map(direction => <div key={direction}
    className={`v1-frame-resize v1-frame-resize-${direction} nodrag nopan`}
    tabIndex={-1} title={`拖动${sides[direction]}调整模块边框`} data-resize-direction={direction}
    onPointerDown={event => start(event, direction)}
    onPointerMove={event => {
      const active = gesture.current;
      if (active?.pointerId === event.pointerId) {
        active.last = { clientX: event.clientX, clientY: event.clientY };
        preview(active.rectangle(active.last, event.altKey));
      }
    }}
    onPointerUp={event => {
      const active = gesture.current;
      if (active?.pointerId !== event.pointerId) return;
      cancel(event);
      const next = active.rectangle(event, event.altKey);
      const before = active.original;
      if (next.x !== before.x || next.y !== before.y || next.width !== before.width || next.height !== before.height) finish(next, before);
    }}
    onPointerCancel={cancel} onLostPointerCapture={cancel}
    onKeyDown={event => {
      if (!gesture.current) return;
      event.stopPropagation();
      if (event.key === 'Alt') { event.preventDefault(); preview(gesture.current.rectangle(gesture.current.last, true)); }
      if (event.key === 'Escape') {
        gesture.current = undefined;
        preview();
        event.preventDefault();
      }
    }}
    onKeyUp={event => {
      if (gesture.current && event.key === 'Alt') { event.preventDefault(); preview(gesture.current.rectangle(gesture.current.last, false)); }
    }}
    onClick={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()} />);
}
