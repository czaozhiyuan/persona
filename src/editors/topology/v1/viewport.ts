import type { Rect, Viewport } from '@xyflow/react';

const visiblePixels = 24;

/** Keeps a visible portion of at least one real node in the viewport. */
export function keepGraphVisible(viewport: Viewport, width: number, height: number, nodes: readonly Rect[]): Viewport {
  if (width <= 0 || height <= 0) return viewport;
  let nearest = viewport;
  let distance = Infinity;
  for (const node of nodes) {
    const w = node.width * viewport.zoom;
    const h = node.height * viewport.zoom;
    if (w <= 0 || h <= 0) continue;
    const overlapX = Math.min(w, width, visiblePixels);
    const overlapY = Math.min(h, height, visiblePixels);
    const left = node.x * viewport.zoom;
    const top = node.y * viewport.zoom;
    const x = Math.min(width - overlapX - left, Math.max(overlapX - left - w, viewport.x));
    const y = Math.min(height - overlapY - top, Math.max(overlapY - top - h, viewport.y));
    const correction = Math.hypot(x - viewport.x, y - viewport.y);
    if (correction === 0) return viewport;
    if (correction < distance) {
      nearest = { ...viewport, x, y };
      distance = correction;
    }
  }
  return nearest;
}
