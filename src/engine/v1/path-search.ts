import type { OpticalChannelId } from '../../model/v1/channels';
import type { PortFlow } from '../../model/v1/types';
import { channelRoutingPorts, portFlowAt } from './signal-graph';
import type { SignalEdge, SignalPort } from './signal-graph';

/** Undefined denotes an unrestricted optical carrier, or no carrier at an electrical port. */
export type Carrier = readonly OpticalChannelId[] | undefined;
export type SignalStep = { readonly port: SignalPort; readonly channelIds?: Carrier };
export type SignalPath = { readonly steps: readonly SignalStep[]; readonly edges: readonly SignalEdge[] };

type State = {
  port: SignalPort;
  carrier: Carrier;
  required: bigint;
  flow?: PortFlow;
  next: Arc[];
  previous: State[];
};
type Arc = { state: State; edge: SignalEdge };

type Search = {
  starts: readonly SignalPort[];
  target?: SignalPort;
  adjacent: ReadonlyMap<SignalPort, readonly SignalEdge[]>;
  carrier: Carrier;
  startCarriers?: ReadonlyMap<SignalPort, Carrier>;
  startFlow?: (port: SignalPort) => PortFlow;
  ignoreChannels?: boolean;
  supplyCarrier?: (edge: SignalEdge) => Carrier;
  targetCarrier?: Carrier;
  targetFlow?: PortFlow;
  required?: ReadonlyMap<SignalEdge, bigint>;
  allRequired?: bigint;
  opticalOnly?: boolean;
  reverse?: boolean;
};

export type SearchResult =
  | { status: 'resolved'; path: SignalPath }
  | { status: 'unreachable'; reached: ReadonlySet<SignalPort> }
  | { status: 'feedback_loop'; endpoint: SignalPort }
  | { status: 'ambiguous'; channelPort?: SignalPort }
  | { status: 'search_limit' };

export const chooseRouteChannel = '该器件有多条按波长选路的光路，请选择光通道。';

/** Only competing routes that actually reach the target can require a wavelength choice. */
function* viableEdges(relevant: ReadonlySet<State>) {
  for (const state of relevant) {
    for (const arc of state.next) {
      if (relevant.has(arc.state)) yield arc.edge;
    }
  }
}

const MAX_STATES = 50_000;
const MAX_ARCS = 250_000;

export function intersectCarrier(a: Carrier, b: Carrier): Carrier {
  return a && b ? a.filter(id => b.includes(id)) : a ?? b;
}

function transition(edge: SignalEdge, active: Carrier, requested: Carrier, reverse: boolean): Carrier | false {
  const channels = edge.channels;
  switch (channels.kind) {
    case 'none': return undefined;
    case 'preserve': return intersectCarrier(active, channels.channelIds);
    case 'enter':
    case 'exit': {
      const entering = (channels.kind === 'enter') !== reverse;
      const allowed = intersectCarrier(entering ? requested : active, channels.channelIds);
      return allowed?.length === 0 ? false : entering ? allowed : undefined;
    }
    case 'convert': {
      const from = reverse ? channels.toChannelId : channels.fromChannelId;
      const to = reverse ? channels.fromChannelId : channels.toChannelId;
      return active && !active.includes(from) ? false : [to];
    }
  }
}

// Propagate the tightest constraint back across each unchanged optical span.
function toPath(states: readonly State[], edges: readonly SignalEdge[], reverse: boolean, targetCarrier: Carrier): SignalPath {
  const steps: SignalStep[] = states.map(({ port, carrier }) => ({ port, channelIds: carrier }));
  const end = steps.length - 1;
  steps[end] = { ...steps[end], channelIds: intersectCarrier(steps[end].channelIds, targetCarrier) };
  for (let i = edges.length - 1; i >= 0; i--) {
    const rule = edges[i].channels;
    if (rule.kind === 'preserve') steps[i] = { ...steps[i], channelIds: steps[i + 1].channelIds };
    if (rule.kind === (reverse ? 'enter' : 'exit') && 'channelIds' in rule) {
      steps[i] = { ...steps[i], channelIds: intersectCarrier(steps[i].channelIds, rule.channelIds) };
    }
    if (rule.kind === 'convert') {
      steps[i] = { ...steps[i], channelIds: [reverse ? rule.toChannelId : rule.fromChannelId] };
    }
  }
  return reverse ? { steps: steps.reverse(), edges: [...edges].reverse() } : { steps, edges };
}

/** Searches a bounded state graph, then counts viable routes up to two without enumerating paths. */
export function searchSignalPath(query: Search): SearchResult {
  const reverse = query.reverse ?? false;
  const allRequired = query.allRequired ?? 0n;
  const index = new Map<SignalPort, Map<string, State>>();
  const pending: State[] = [];
  const targets: State[] = [];

  function stateAt(port: SignalPort, carrier: Carrier, required: bigint, arrival?: PortFlow): State {
    const flow = port.definition.direction === 'bidirectional' ? arrival : undefined;
    const key = JSON.stringify([carrier && [...carrier].sort(), required.toString(), flow]);
    let atPort = index.get(port);
    if (!atPort) {
      atPort = new Map();
      index.set(port, atPort);
    }
    let state = atPort.get(key);
    if (!state) {
      state = { port, carrier, required, flow, next: [], previous: [] };
      atPort.set(key, state);
      pending.push(state);
    }
    return state;
  }

  const starts = new Set<State>();
  for (const port of query.starts) {
    const carrier = !query.ignoreChannels && port.definition.type === 'OPTICAL'
      ? intersectCarrier(intersectCarrier(query.carrier, query.startCarriers?.get(port)), port.definition.channelIds) : undefined;
    if (carrier?.length !== 0) starts.add(stateAt(port, carrier, 0n, query.startFlow?.(port)));
  }
  if (pending.length > MAX_STATES) return { status: 'search_limit' };

  let arcCount = 0;
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const current = pending[cursor];
    if (current.port === query.target && (!query.targetFlow || !current.flow || current.flow === query.targetFlow)) {
      if (current.required === allRequired && intersectCarrier(current.carrier, query.targetCarrier)?.length !== 0) {
        targets.push(current);
      }
      continue;
    }
    for (const edge of query.adjacent.get(current.port) ?? []) {
      if (current.flow && current.flow !== portFlowAt(edge, current.port)) continue;
      const port = reverse ? edge.from : edge.to;
      if (query.opticalOnly && port.definition.type !== 'OPTICAL') continue;
      const emitted = edge.channels.kind === 'enter' && !edge.supply ? query.startCarriers?.get(edge.to) : undefined;
      const requested = intersectCarrier(query.carrier, edge.supply && query.supplyCarrier ? query.supplyCarrier(edge) : emitted);
      const carrier = query.ignoreChannels ? undefined : transition(edge, current.carrier, requested, reverse);
      if (carrier === false || carrier?.length === 0) continue;
      const next = stateAt(port, carrier, current.required | (query.required?.get(edge) ?? 0n), portFlowAt(edge, port));
      if (pending.length > MAX_STATES || ++arcCount > MAX_ARCS) return { status: 'search_limit' };
      current.next.push({ state: next, edge });
      next.previous.push(current);
    }
  }
  if (targets.length === 0) return { status: 'unreachable', reached: new Set(pending.map(state => state.port)) };

  // Only a state that can reach an admissible target can affect the query.
  const relevant = new Set(targets);
  for (const state of relevant) {
    for (const before of state.previous) relevant.add(before);
  }
  const remaining = new Map<State, number>();
  const counts = new Map<State, number>();
  const ready = [...targets];
  for (const state of relevant) remaining.set(state, state.next.filter(arc => relevant.has(arc.state)).length);
  for (const target of targets) counts.set(target, 1);
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const state = ready[cursor];
    for (const before of state.previous) {
      counts.set(before, Math.min(2, (counts.get(before) ?? 0) + counts.get(state)!));
      const outgoing = remaining.get(before)! - 1;
      remaining.set(before, outgoing);
      if (outgoing === 0) ready.push(before);
    }
  }
  if (ready.length !== relevant.size) {
    // Kahn's pass leaves cycle predecessors too. Follow live successors to an actual repeat.
    let cycle = [...relevant].find(state => remaining.get(state)! > 0)!;
    const visited = new Set<State>();
    while (!visited.has(cycle)) {
      visited.add(cycle);
      cycle = cycle.next.find(arc => (remaining.get(arc.state) ?? 0) > 0)!.state;
    }
    return { status: 'feedback_loop', endpoint: cycle.port };
  }

  const viable = [...starts].filter(state => counts.has(state));
  if (viable.length !== 1) return { status: 'ambiguous' };
  if (counts.get(viable[0]) !== 1) {
    const routers = query.carrier?.length === 1 || query.targetCarrier?.length === 1 ? undefined : channelRoutingPorts(viableEdges(relevant));
    const channelPort = routers?.from.values().next().value ?? routers?.to.values().next().value;
    return { status: 'ambiguous', channelPort };
  }
  const states = [viable[0]];
  const edges: SignalEdge[] = [];
  while (states.at(-1)!.next.length) {
    const next = states.at(-1)!.next.find(arc => counts.has(arc.state))!;
    states.push(next.state);
    edges.push(next.edge);
  }
  return { status: 'resolved', path: toPath(states, edges, reverse, query.targetCarrier) };
}
