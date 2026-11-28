import { getSmoothStepPath, Position } from '@xyflow/react';
import type { Transfer } from '../../../model/v1/device';
import type { PortDefinition } from '../../../model/v1/types';

export type ControlRoute = Extract<Transfer, { kind: 'control' }>;
export const routeId = (input: string, output: string) => encodeURIComponent(JSON.stringify([input, output]));
export const portWidth = 190;
export const portHeight = 30;
const colors = ['#2564ad', '#ba531b', '#167768', '#7556ad', '#ac3f68', '#806716'];

type Point = [number, number];
type Network = {
  input: string; color: string; path: string; junctions: Point[];
  branches: { id: string; output: string; path: string }[];
};

function horizontalRoute(sourceX: number, sourceY: number, centerX: number, targetX: number, targetY: number) {
  return getSmoothStepPath({ sourceX, sourceY, centerX, targetX, targetY, sourcePosition: Position.Right,
    targetPosition: Position.Left, borderRadius: 6, offset: 0 })[0];
}

export function controlNetworks(inputs: readonly PortDefinition[], outputs: readonly PortDefinition[], routes: readonly ControlRoute[], organize: boolean) {
  const targets = new Map<string, Set<string>>();
  const visibleOutputs = new Set(outputs.map(port => port.id));
  for (const route of routes) {
    if (!visibleOutputs.has(route.toPortId)) continue;
    const ids = targets.get(route.fromPortId) ?? new Set<string>();
    ids.add(route.toPortId);
    targets.set(route.fromPortId, ids);
  }
  const active = inputs.flatMap((port, row) => targets.has(port.id) ? [{ input: port.id, row }] : []);
  const drivers = outputs.map(port => active.filter(net => targets.get(net.input)!.has(port.id)));
  const rowStep = Math.max(48, ...drivers.map(list => list.length * 10 + 22));
  const channelWidth = Math.max(310, 40 * active.length + 40);
  const columnX = portWidth + channelWidth;
  const rowY = (index: number) => portHeight / 2 + rowStep * index;
  const nets = active.map((net, i) => {
    const taps = outputs.flatMap((out, row) => {
      const group = drivers[row], slot = group.indexOf(net);
      if (slot < 0) return [];
      // Separate incoming nets until the last few pixels of a common handle.
      const offset = (slot - (group.length - 1) / 2) * 10;
      const y = rowY(row) + offset;
      const contactY = rowY(row) + (group.length === 1 ? 0 : 6 * (slot / (group.length - 1) - 0.5));
      return [{ output: out.id, y, contactY, contactX: columnX - 12 - 2 * slot }];
    });
    const sourceY = rowY(net.row);
    const midY = (taps[0].y + taps[taps.length - 1].y) / 2;
    return { ...net, color: colors[i % colors.length], sourceY, midY, taps };
  });
  const laneOrder = organize ? nets.slice().sort((a, b) => (b.midY - b.sourceY) - (a.midY - a.sourceY)) : nets;
  const laneX = new Map(laneOrder.map((net, i) => [net.input, portWidth + channelWidth * (0.16 + 0.52 * (i + 0.5) / nets.length)]));
  const tracks: number[] = [];
  const networks: Network[] = nets.map((net, i) => {
    const turn = laneX.get(net.input)!;
    const fork = portWidth + channelWidth * (0.74 + 0.16 * (i + 0.5) / nets.length);
    const { input, color, sourceY, midY, taps } = net;
    // A straight run into a single output can share a row with an input
    // only when the two horizontal spans do not overlap.
    const blocked = nets.flatMap(other => {
      const occupied = other === net ? [] : other.taps.map(tap => tap.y);
      if (other !== net && laneX.get(other.input)! >= turn) occupied.push(other.sourceY);
      return occupied;
    });
    if (taps.length > 1) blocked.push(...taps.map(tap => tap.y));
    blocked.push(...tracks);
    let trackY = midY;
    for (let step = 1; blocked.some(y => Math.abs(y - trackY) < 7); step++) {
      trackY = midY + Math.ceil(step / 2) * 8 * (step % 2 ? -1 : 1);
    }
    tracks.push(trackY);
    const trunk = horizontalRoute(portWidth, sourceY, turn, fork, trackY);
    const low = Math.min(trackY, taps[0].y), high = Math.max(trackY, taps[taps.length - 1].y);
    const rail = (a: number, b: number) => a === b ? '' : 'M' + [fork, a] + ' V' + b;
    const ends = taps.map(tap => horizontalRoute(fork, tap.y, tap.contactX, columnX, tap.contactY));
    const branches = taps.map((tap, index) => ({ id: routeId(input, tap.output), output: tap.output,
      path: [trunk, rail(trackY, tap.y), ends[index]].join(' ') }));
    const junctions: Point[] = [trackY, ...taps.map(tap => tap.y)].filter(y => y > low && y < high).map(y => [fork, y]);
    return { input, color, path: [trunk, rail(low, high), ...ends].join(' '), branches, junctions };
  });
  return { networks, columnX, rowStep };
}
