import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { Project } from '../../../model/v1/types';
import { extendExpansionLayout, planInlineExpansion, type ExpansionLayout } from './inline-expansion-layout';
import { measureFramePorts, type FramePortHeights } from './module-frame';
import { projectTopology } from './topology-projection';
import type { Projection } from './topology-layout-edits';

type Sizes = Parameters<typeof projectTopology>[4];
type Heights = ReadonlyMap<string, FramePortHeights>;
type Request = { keys: Set<string>; persist: boolean };

export function useInlineExpansion(canvas: RefObject<HTMLDivElement | null>, base: Project, displayed: Project,
  projection: Projection, instances: Parameters<typeof projectTopology>[1], scope: Parameters<typeof projectTopology>[2],
  expanded: ReadonlySet<string>, measured: Sizes, heights: Heights, active: boolean, persist: boolean,
  finish: (base: Project, layout: ExpansionLayout, persist: boolean) => void) {
  const previous = useRef<{ project: Project; view: Projection; expanded: ReadonlySet<string>; sizes: Sizes; heights: Heights }>(undefined);
  const pending = useRef<Request>(undefined);
  useLayoutEffect(() => {
    const old = previous.current;
    if (old?.project !== base) pending.current = undefined;
    if (!active) {
      if (pending.current) pending.current.persist = false;
      return;
    }
    previous.current = { project: base, view: projection, expanded, sizes: measured, heights };
    const opened = [...projection.scopes.keys()].filter(key => key !== projection.rootKey && !old?.view.scopes.has(key));
    if (opened.length) {
      pending.current = { keys: new Set([...(pending.current?.keys ?? []), ...opened]),
        persist: old?.project === base && old.expanded !== expanded && persist };
    } else if (old && old.project !== base && old.view.expansionPreview && !projection.expansionPreview
      && JSON.stringify(old.project.layout?.topology) === JSON.stringify(base.layout?.topology)
      && JSON.stringify(old.project.layout?.topologyFrames) === JSON.stringify(base.layout?.topologyFrames)) {
      // An unrelated property edit can keep the tree's preview without writing it into history.
      pending.current = { keys: new Set([...projection.scopes.keys()].filter(key => key !== projection.rootKey)), persist: false };
    } else if (projection.scopes.size > 1 && old?.project === base && old.expanded === expanded && (old.sizes !== measured || old.heights !== heights)) {
      // Text and port rows can grow after a selection or label change. Recheck just their visible branch.
      for (const node of projection.nodes) {
        const size = measured.get(node.key), before = old.sizes.get(node.key);
        const pins = heights.get(node.key), beforePins = old.heights.get(node.key);
        const grew = node.frame ? pins && beforePins && (pins.top > beforePins.top || pins.side > beforePins.side)
          : size && before && (size.width > before.width || size.height > before.height);
        if (!grew || (!node.frame && (!node.parentKey || node.parentKey === projection.rootKey)
          && !projection.scopes.get(projection.rootKey)?.members.some(n => n.frame))) continue;
        (pending.current ??= { keys: new Set(), persist: false }).keys.add(node.key);
      }
    }
    const request = pending.current;
    if (!request) return;
    for (const key of request.keys) {
      if (!projection.nodeByKey.has(key) || (old?.view.scopes.has(key) && !projection.scopes.has(key))) request.keys.delete(key);
    }
    if (!request.keys.size) {
      pending.current = undefined;
      return;
    }
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
      const actual = projectTopology(displayed, instances, scope, expanded, sizes, undefined, ports);
      const edit = planInlineExpansion(actual, request.keys);
      if (edit.moves.length || edit.frames.length) finish(base, extendExpansionLayout(projection.expansionPreview, edit), request.persist);
    }
    handle = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(handle);
  }, [canvas, base, displayed, projection, instances, scope, expanded, measured, heights, active, persist, finish]);
  return () => { pending.current = undefined; };
}
