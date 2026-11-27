import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, DragEvent } from 'react';
import type { XYPosition } from '@xyflow/react';
import type { LibraryItem } from '../../library/v1/insert-library-item';

export type LibraryPointerPlacement = (screen?: XYPosition, free?: boolean, item?: LibraryItem) => void;

// Native HTML drag suppresses keyboard events while the pointer is stationary.
export function useLibraryPointerDrag(place: LibraryPointerPlacement) {
  const press = useRef<{ id: number; item: LibraryItem; start: XYPosition; screen: XYPosition; moved: boolean }>(undefined);
  const blockClick = useRef(false);
  function cancel() {
    press.current = undefined;
    place();
  }
  useEffect(() => {
    function key(event: KeyboardEvent) {
      const active = press.current;
      if (!active?.moved) return;
      if (event.key === 'Escape') cancel();
      if (event.key === 'Alt') {
        event.preventDefault();
        place(active.screen, event.type === 'keydown');
      }
    }
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', key);
      window.removeEventListener('blur', cancel);
    };
  });
  return {
    start(event: ReactPointerEvent<HTMLButtonElement>, item: LibraryItem) {
      if (!event.isPrimary || event.button !== 0 || !item.name) return;
      const start = { x: event.clientX, y: event.clientY };
      press.current = { id: event.pointerId, item, start, screen: start, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    events: {
      onPointerDownCapture(event: ReactPointerEvent) { if (event.isPrimary && event.button === 0) blockClick.current = false; },
      onDragStartCapture(event: DragEvent) { if (press.current) event.preventDefault(); },
      onPointerMove(event: ReactPointerEvent) {
        const active = press.current;
        if (active?.id !== event.pointerId) return;
        active.screen = { x: event.clientX, y: event.clientY };
        if (!active.moved && Math.hypot(event.clientX - active.start.x, event.clientY - active.start.y) < 4) return;
        active.moved = blockClick.current = true;
        place(active.screen, event.altKey);
      },
      onPointerUp(event: ReactPointerEvent) {
        const active = press.current;
        if (active?.id !== event.pointerId) return;
        press.current = undefined;
        if (active.moved) place({ x: event.clientX, y: event.clientY }, event.altKey, active.item);
      },
      onLostPointerCapture(event: ReactPointerEvent) {
        if (press.current?.id === event.pointerId) cancel();
      },
      onClickCapture(event: ReactMouseEvent) {
        if (blockClick.current && event.detail) {
          blockClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      },
    },
  };
}
