import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { Project } from '../../../model/v1/types';
import { extendExpansionLayout, planInlineExpansion, type ExpansionLayout } from './inline-expansion-layout';
import { measureFramePorts, type FramePortHeights } from './module-frame';
import { projectTopology, type TopologyItem } from './topology-projection';
import type { Projection } from './topology-layout-edits';

type Sizes = Parameters<typeof projectTopology>[4];
type Heights = ReadonlyMap<string, FramePortHeights>;
export type ExpansionAction = 'preview' | 'commit' | 'extend';
type Request = { keys: Set<string>; action: ExpansionAction; beforeEdit?: Projection };

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

export function useInlineExpansion(canvas: RefObject<HTMLDivElement | null>, base: Project, displayed: Project,
  projection: Projection, instances: Parameters<typeof projectTopology>[1], scope: Parameters<typeof projectTopology>[2],
  expanded: ReadonlySet<string>, measured: Sizes, heights: Heights, active: boolean, persist: boolean, manualFrames: ReadonlySet<string>,
  finish: (base: Project, layout: ExpansionLayout, action: ExpansionAction) => void) {
  const previous = useRef<{ project: Project; view: Projection; expanded: ReadonlySet<string>; sizes: Sizes; heights: Heights }>(undefined);
  const pending = useRef<Request>(undefined);
  useLayoutEffect(() => {
    const old = previous.current;
    if (old?.project !== base) pending.current = undefined;
    if (!active) {
      if (pending.current) pending.current.action = 'preview';
      return;
    }
    previous.current = { project: base, view: projection, expanded, sizes: measured, heights };
    const opened = [...projection.scopes.keys()].filter(key => key !== projection.rootKey && !old?.view.scopes.has(key));
    if (opened.length) {
      const command = old?.project === base && old.expanded !== expanded && persist;
      pending.current = { keys: new Set([...(pending.current?.keys ?? []), ...opened]),
        action: command ? 'commit' : 'preview' };
    } else if (old && old.project !== base) {
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
      if (edited.size) pending.current = { keys: edited, action: 'extend', beforeEdit: old.view };
      else if (old.view.expansionPreview && !projection.expansionPreview
        && JSON.stringify(old.project.layout?.topology) === JSON.stringify(base.layout?.topology)
        && JSON.stringify(old.project.layout?.topologyFrames) === JSON.stringify(base.layout?.topologyFrames)) {
        // An unrelated property edit can keep the tree's preview without writing it into history.
        pending.current = { keys: new Set([...projection.scopes.keys()].filter(key => key !== projection.rootKey)), action: 'preview' };
      }
    } else if (pending.current?.action !== 'extend' && projection.scopes.size > 1 && old?.project === base
      && old.expanded === expanded && (old.sizes !== measured || old.heights !== heights)) {
      // Text and port rows can grow after a selection or label change. Recheck just their visible branch.
      for (const node of projection.nodes) {
        const size = measured.get(node.key), before = old.sizes.get(node.key);
        const pins = heights.get(node.key), beforePins = old.heights.get(node.key);
        const grew = node.frame ? pins && beforePins && (pins.top > beforePins.top || pins.side > beforePins.side)
          : size && before && (size.width > before.width || size.height > before.height);
        if (!grew || (!node.frame && (!node.parentKey || node.parentKey === projection.rootKey)
          && !projection.scopes.get(projection.rootKey)?.members.some(n => n.frame))) continue;
        (pending.current ??= { keys: new Set(), action: 'preview' }).keys.add(node.key);
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
      if (request.beforeEdit) for (const key of request.keys) {
        const before = request.beforeEdit.nodeByKey.get(key), after = actual.nodeByKey.get(key);
        if (!before || !after || !grewSinceEdit(before, after)) request.keys.delete(key);
      }
      const edit = planInlineExpansion(actual, request.keys, request.beforeEdit);
      if (edit.moves.length || edit.frames.length) finish(base, extendExpansionLayout(projection.expansionPreview, edit), request.action);
    }
    handle = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(handle);
  }, [canvas, base, displayed, projection, instances, scope, expanded, measured, heights, active, persist, manualFrames, finish]);
  return () => { pending.current = undefined; };
}
