import type { CoordinateExtent, Rect, XYPosition } from '@xyflow/react';
import { framePadding, frameInsets } from './module-frame';

type Insets = ReturnType<typeof frameInsets>;
export type ResizeDirection = 'n' | 's' | 'w' | 'e' | 'nw' | 'ne' | 'sw' | 'se';

const right = (rect: Rect) => rect.x + rect.width;
const bottom = (rect: Rect) => rect.y + rect.height;

export function fitModuleFrame(children: readonly Rect[], insets: Insets): Rect {
  const x = (children.length ? Math.min(...children.map(child => child.x)) : 0) - insets.left;
  const y = (children.length ? Math.min(...children.map(child => child.y)) : 0) - insets.top;
  const edge = Math.max(x, ...children.map(right));
  const base = Math.max(y, ...children.map(bottom));
  return {
    x, y,
    width: Math.max(insets.minWidth, edge - x + insets.right),
    height: Math.max(insets.height, base - y + framePadding),
  };
}

export function minimumFrame(children: readonly Rect[], insets: Insets) {
  return {
    width: Math.max(insets.minWidth, Math.max(0, ...children.map(child => child.width)) + insets.left + insets.right),
    height: Math.max(insets.height, Math.max(0, ...children.map(child => child.height)) + insets.top + framePadding),
  };
}

export function moduleExtent(frame: Rect, insets: Insets): CoordinateExtent {
  return [[frame.x + insets.left, frame.y + insets.top], [right(frame) - insets.right, bottom(frame) - framePadding]];
}

export function keepNodeInside(node: Rect, extent: CoordinateExtent): XYPosition {
  const [[left, top], [right, bottom]] = extent;
  return {
    x: Math.max(left, Math.min(node.x, right - node.width)),
    y: Math.max(top, Math.min(node.y, bottom - node.height)),
  };
}

export function dragFrame(frame: Rect, direction: ResizeDirection, delta: XYPosition, children: readonly Rect[], insets: Insets,
  originLimit?: XYPosition): Rect {
  const { width, height } = minimumFrame(children, insets);
  const left = direction.includes('w') ? Math.min(Math.max(frame.x + delta.x, originLimit?.x ?? -Infinity), right(frame) - width,
    ...children.map(child => child.x - insets.left)) : frame.x;
  const top = direction.includes('n') ? Math.min(Math.max(frame.y + delta.y, originLimit?.y ?? -Infinity), bottom(frame) - height,
    ...children.map(child => child.y - insets.top)) : frame.y;
  const east = direction.includes('e') ? Math.max(right(frame) + delta.x, frame.x + width,
    ...children.map(child => right(child) + insets.right)) : right(frame);
  const south = direction.includes('s') ? Math.max(bottom(frame) + delta.y, frame.y + height,
    ...children.map(child => bottom(child) + framePadding)) : bottom(frame);
  return { x: left, y: top, width: east - left, height: south - top };
}
