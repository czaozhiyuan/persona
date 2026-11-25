import { signalPortKey } from '../../../engine/v1/signal-graph';
import type { SignalGraph } from '../../../engine/v1/signal-graph';
import type { NamedLink } from '../../../model/v1/topology';

export type LinkFields = { from?: string; to?: string; channelId?: NamedLink['channelId'] | '' };
export type LinkDraft = LinkFields & { id: string; editing: boolean; canvas: boolean };

/** Keep an unsubmitted change separate from the saved link, including an explicit empty field. */
export function stageLinkFields(draft: LinkDraft | undefined, saved: NamedLink | undefined, fields: LinkFields,
  canvas: boolean, newId: () => string): LinkDraft {
  const previous = draft && (saved ? draft.editing && draft.id === saved.id : !draft.editing) ? draft : undefined;
  const next = { ...previous, id: saved?.id ?? previous?.id ?? newId(), editing: !!saved, canvas: canvas || !!previous?.canvas, ...fields };
  for (const side of ['from', 'to'] as const) {
    const original = saved?.[side];
    if (fields[side] === (original ? signalPortKey(original) : '')) delete next[side];
  }
  if (fields.channelId === (saved?.channelId ?? '')) delete next.channelId;
  return next;
}

export function cleanLinkDraft(draft: LinkDraft, graph: SignalGraph) {
  const { from, to } = draft;
  const missingFrom = from && !graph.ports.has(from), missingTo = to && !graph.ports.has(to);
  return missingFrom || missingTo ? { ...draft, from: missingFrom ? undefined : from, to: missingTo ? undefined : to } : draft;
}

export function previewLinkDraft(draft: LinkDraft, saved: NamedLink | undefined, graph: SignalGraph): NamedLink {
  return { ...(saved ?? { id: draft.id, name: '新链路' }),
    from: draft.from === undefined ? saved?.from : graph.ports.get(draft.from)?.ref,
    to: draft.to === undefined ? saved?.to : graph.ports.get(draft.to)?.ref,
    channelId: (draft.channelId ?? saved?.channelId) || undefined };
}
