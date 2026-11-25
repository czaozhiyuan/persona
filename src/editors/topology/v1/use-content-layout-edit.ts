import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { Project } from '../../../model/v1/types';
import { applyExpansionLayout, planInlineExpansion, type ExpansionLayout } from './inline-expansion-layout';
import { measureFramePorts, type FramePortHeights } from './module-frame';
import { projectTopology, type TopologyItem } from './topology-projection';
import type { Projection } from './topology-layout-edits';

type Sizes = Parameters<typeof projectTopology>[4];
type Heights = ReadonlyMap<string, FramePortHeights>;

function nodeContent({ item }: TopologyItem) {
  return JSON.stringify([item.definition.name, item.definition.ports, item.instance?.name,
    item.instance?.parameterOverrides, item.settings]);
}

function grewSinceEdit(before: TopologyItem, after: TopologyItem) {
  const a = before.frame?.display ?? before.bounds, b = after.frame?.display ?? after.bounds;
  return b.width > a.width || b.height > a.height || !!(before.frame && after.frame && (
    after.frame.insets.top > before.frame.insets.top || after.frame.insets.left > before.frame.insets.left
    || after.frame.insets.right > before.frame.insets.right));
}

// Content edits can change measured card or port sizes and share the edit's undo entry.
export function useContentLayoutEdit(canvas: RefObject<HTMLDivElement | null>, base: Project, projection: Projection,
  layout: ExpansionLayout, instances: Parameters<typeof projectTopology>[1], scope: Parameters<typeof projectTopology>[2],
  expanded: ReadonlySet<string>, measured: Sizes, heights: Heights, active: boolean, manualFrames: ReadonlySet<string>,
  finish: (base: Project, layout: ExpansionLayout) => void) {
  const previous = useRef<{ project: Project; view: Projection; layout: ExpansionLayout }>(undefined);
  const pending = useRef<{ keys: Set<string>; before: Projection; layout: ExpansionLayout }>(undefined);
  useLayoutEffect(() => {
    const old = previous.current;
    previous.current = { project: base, view: projection, layout };
    if (!active || old?.view.rootKey !== projection.rootKey) {
      pending.current = undefined;
      return;
    }
    if (old.project !== base) {
      pending.current = undefined;
      const edited = new Set<string>();
      const affectedScopes = new Set<string>();
      for (const key of manualFrames) {
        const node = projection.nodeByKey.get(key);
        if (node?.frame) affectedScopes.add(key).add(node.parentKey ?? projection.rootKey);
      }
      for (const node of projection.nodes) {
        const before = old.view.nodeByKey.get(node.key);
        const inManualBranch = node.frame ? manualFrames.has(node.key) : affectedScopes.has(node.parentKey ?? projection.rootKey);
        if (inManualBranch && before && nodeContent(node) !== nodeContent(before)) edited.add(node.key);
      }
      if (edited.size) pending.current = { keys: edited, before: old.view, layout: old.layout };
    }
    const request = pending.current;
    if (!request) return;
    let handle: number;
    function measure() {
      if (!canvas.current || request !== pending.current || !request) return;
      const elements = new Map(Array.from(canvas.current.querySelectorAll<HTMLElement>('.react-flow__node[data-id]'),
        element => [decodeURIComponent(element.dataset.id!), element]));
      const sizes = new Map(measured), ports = new Map(heights);
      for (const node of projection.nodes) {
        const el = elements.get(node.key);
        // React Flow may still be swapping the folded card for its frame (or mounting descendants).
        if (!el?.offsetWidth || !!node.frame !== el.classList.contains('react-flow__node-moduleFrame')) {
          handle = requestAnimationFrame(measure);
          return;
        }
        if (node.frame) ports.set(node.key, measureFramePorts(Array.from(el.querySelectorAll<HTMLElement>('.v1-module-pins'))));
        else sizes.set(node.key, { width: el.offsetWidth, height: el.offsetHeight });
      }
      pending.current = undefined;
      const actual = projectTopology(applyExpansionLayout(base, request.layout), instances, scope, expanded, sizes, undefined, ports);
      for (const key of request.keys) {
        const before = request.before.nodeByKey.get(key), after = actual.nodeByKey.get(key);
        if (!before || !after || !grewSinceEdit(before, after)) request.keys.delete(key);
      }
      const edit = planInlineExpansion(actual, request.keys, request.before);
      if (edit.moves.length || edit.frames.length) finish(base, edit);
    }
    handle = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(handle);
  }, [canvas, base, projection, layout, instances, scope, expanded, measured, heights, active, manualFrames, finish]);
  return () => { pending.current = undefined; };
}
